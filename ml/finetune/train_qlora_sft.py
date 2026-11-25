#!/usr/bin/env python3
"""
TryVibe Fashion Atelier — Offline 4-bit QLoRA SFT Fine-Tuning Pipeline.

Trains Qwen 2.5 Instruct (`Qwen/Qwen2.5-3B-Instruct` default, supports `Qwen/Qwen2.5-7B-Instruct`)
on Zero-PII ChatML/ShareGPT datasets exported by `pnpm ai:export-sft`:
  - `artifacts/finetune-dataset/train.jsonl`
  - `artifacts/finetune-dataset/val.jsonl`

Features:
  - Strict pre-training Zero-PII + Shannon Entropy Gate (fails non-zero on any leak).
  - 4-bit NF4 QLoRA (r=16, lora_alpha=32, lora_dropout=0.05) across all 7 linear projections.
  - Prefers `unsloth.FastLanguageModel` when installed, with automatic fallback to
    `transformers + peft + trl.SFTTrainer` (works on local NVIDIA GPU & Google Colab/Cloud GPU).
  - Exports merged GGUF (`Q4_K_M`) ready for `ml/finetune/Modelfile.atelier-copilot`.
  - `--dry-run` validates datasets, Zero-PII compliance, LoRA config & prints training plan
    without requiring a CUDA GPU or torch installation.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE_MODEL = "Qwen/Qwen2.5-3B-Instruct"
DEFAULT_TRAIN_FILE = REPO_ROOT / "artifacts" / "finetune-dataset" / "train.jsonl"
DEFAULT_VAL_FILE = REPO_ROOT / "artifacts" / "finetune-dataset" / "val.jsonl"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "ml" / "finetune" / "outputs" / "sft-adapter"
DEFAULT_GGUF_OUTPUT = (
    REPO_ROOT / "ml" / "finetune" / "outputs" / "atelier-copilot-sft-q4_k_m.gguf"
)

TARGET_MODULES: list[str] = [
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
]

ENTROPY_THRESHOLD = 4.2
ENTROPY_MIN_LEN = 24
TOKEN_CANDIDATE_RE = re.compile(r"[A-Za-z0-9+/=_-]{24,}")

PII_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    (
        "vn_phone",
        re.compile(
            r"(?<!\d)(?:\+84[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|(?:\+84|0)[35789]\d{8}|0\d{3}[\s.-]\d{3}[\s.-]\d{3})(?!\d)"
        ),
    ),
    (
        "vn_street_address",
        re.compile(
            r"(?:số|so)\s+\d+[^\n]{0,80}(?:phường|phuong|quận|quan|đường|duong|phố|pho)",
            re.IGNORECASE,
        ),
    ),
    (
        "secret_token",
        re.compile(
            r"Bearer\s+[A-Za-z0-9._-]{12,}|Atelier_[A-Za-z0-9!]+|Atelier@2026!|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}"
        ),
    ),
    (
        "tryon_private_ref",
        re.compile(r"atelier-private-tryon|temp_user_images|tryon-raw", re.IGNORECASE),
    ),
    (
        "raw_body_or_pii_key",
        re.compile(
            r'"(bustCm|waistCm|hipCm|heightCm|weightKg|reviewerHeightCm|reviewerWeightKg|streetLine|customerPhone|customerEmail|userPhotoUrl|tryonImageUrl)"'
        ),
    ),
]


def shannon_entropy(text: str) -> float:
    if not text:
        return 0.0
    counts = Counter(text)
    length = len(text)
    return -sum((c / length) * math.log2(c / length) for c in counts.values())


def scan_line_zero_pii(line: str, file_label: str, line_no: int) -> list[str]:
    issues: list[str] = []
    for name, pattern in PII_PATTERNS:
        if pattern.search(line):
            issues.append(f"{file_label}:{line_no} matched PII/secret pattern '{name}'")
    for match in TOKEN_CANDIDATE_RE.finditer(line):
        tok = match.group(0)
        if len(tok) >= ENTROPY_MIN_LEN:
            ent = shannon_entropy(tok)
            if ent > ENTROPY_THRESHOLD:
                issues.append(
                    f"{file_label}:{line_no} high-entropy token detected "
                    f"(len={len(tok)}, entropy={ent:.3f} > {ENTROPY_THRESHOLD})"
                )
    return issues


def load_and_validate_chatml(path: Path) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if not path.exists():
        raise FileNotFoundError(
            f"SFT dataset file not found: {path}. Run `pnpm ai:export-sft` first."
        )

    records: list[dict[str, Any]] = []
    task_counts: Counter[str] = Counter()
    pii_issues: list[str] = []

    with path.open("r", encoding="utf-8") as fh:
        for idx, raw_line in enumerate(fh, start=1):
            line = raw_line.strip()
            if not line:
                continue
            pii_issues.extend(scan_line_zero_pii(line, path.name, idx))
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path.name}:{idx} invalid JSON: {exc}") from exc

            if obj.get("format") != "chatml":
                raise ValueError(
                    f"{path.name}:{idx} expected format='chatml', got {obj.get('format')!r}"
                )
            messages = obj.get("messages")
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError(
                    f"{path.name}:{idx} 'messages' must be a list with >= 2 turns"
                )
            roles = []
            for m_idx, msg in enumerate(messages):
                role = msg.get("role") if isinstance(msg, dict) else None
                content = msg.get("content") if isinstance(msg, dict) else None
                if role not in {"system", "user", "assistant"}:
                    raise ValueError(
                        f"{path.name}:{idx} message[{m_idx}] invalid role: {role!r}"
                    )
                if not isinstance(content, str) or not content.strip():
                    raise ValueError(
                        f"{path.name}:{idx} message[{m_idx}] must have non-empty string content"
                    )
                roles.append(role)
            if "user" not in roles or "assistant" not in roles:
                raise ValueError(
                    f"{path.name}:{idx} messages must contain both 'user' and 'assistant' turns"
                )

            task_counts[str(obj.get("taskType", "unknown"))] += 1
            records.append(obj)

    if pii_issues:
        joined = "\n  - ".join(pii_issues[:10])
        raise RuntimeError(
            f"Zero-PII Gate FAILED on {path} ({len(pii_issues)} violations):\n  - {joined}"
        )
    if not records:
        raise ValueError(f"Dataset file {path} is empty.")

    return records, dict(task_counts)


def probe_runtime_capabilities() -> dict[str, Any]:
    has_unsloth = importlib.util.find_spec("unsloth") is not None
    has_torch = importlib.util.find_spec("torch") is not None
    has_transformers = importlib.util.find_spec("transformers") is not None
    has_peft = importlib.util.find_spec("peft") is not None
    has_trl = importlib.util.find_spec("trl") is not None
    has_bnb = importlib.util.find_spec("bitsandbytes") is not None

    cuda_available = False
    gpu_name = None
    if has_torch:
        try:
            import torch  # type: ignore

            cuda_available = bool(torch.cuda.is_available())
            if cuda_available:
                gpu_name = torch.cuda.get_device_name(0)
        except Exception:
            cuda_available = False

    preferred_backend = (
        "unsloth.FastLanguageModel"
        if has_unsloth
        else (
            "transformers+peft+trl.SFTTrainer"
            if (has_transformers and has_peft and has_trl)
            else "unavailable_install_ml_finetune_deps"
        )
    )
    return {
        "preferredBackend": preferred_backend,
        "unslothInstalled": has_unsloth,
        "torchInstalled": has_torch,
        "transformersInstalled": has_transformers,
        "peftInstalled": has_peft,
        "trlInstalled": has_trl,
        "bitsandbytesInstalled": has_bnb,
        "cudaAvailable": cuda_available,
        "gpuName": gpu_name,
    }


def render_qwen_chatml(messages: list[dict[str, str]]) -> str:
    parts: list[str] = []
    for msg in messages:
        parts.append(f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>\n")
    return "".join(parts)


def export_merged_gguf_fallback(
    merged_hf_dir: Path, gguf_output: Path, quant_method: str
) -> dict[str, Any]:
    gguf_output.parent.mkdir(parents=True, exist_ok=True)
    converter = shutil.which("convert_hf_to_gguf.py") or shutil.which(
        "llama-convert-hf-to-gguf"
    )
    quantizer = shutil.which("llama-quantize")
    f16_gguf = gguf_output.with_name(f"{gguf_output.stem}-f16.gguf")

    if converter and quantizer:
        subprocess.run(
            [
                sys.executable,
                converter,
                str(merged_hf_dir),
                "--outfile",
                str(f16_gguf),
                "--outtype",
                "f16",
            ],
            check=True,
        )
        subprocess.run(
            [quantizer, str(f16_gguf), str(gguf_output), quant_method.upper()],
            check=True,
        )
        return {"exported": True, "path": str(gguf_output), "method": "llama.cpp"}

    return {
        "exported": False,
        "mergedHfDir": str(merged_hf_dir),
        "targetGgufPath": str(gguf_output),
        "nextStepCommand": (
            f"python convert_hf_to_gguf.py {merged_hf_dir} --outfile {f16_gguf} --outtype f16 && "
            f"llama-quantize {f16_gguf} {gguf_output} {quant_method.upper()}"
        ),
    }


def run_live_sft_training(
    args: argparse.Namespace,
    train_records: list[dict[str, Any]],
    val_records: list[dict[str, Any]],
) -> dict[str, Any]:
    import torch  # type: ignore
    from datasets import Dataset  # type: ignore
    from trl import SFTConfig, SFTTrainer  # type: ignore

    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA GPU is required for live 4-bit QLoRA training. "
            "Use `--dry-run` on CPU hosts or run on an NVIDIA GPU / Colab runtime."
        )

    use_bf16 = bool(torch.cuda.is_bf16_supported())
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.gguf_output.parent.mkdir(parents=True, exist_ok=True)

    train_ds = Dataset.from_list(
        [{"text": render_qwen_chatml(r["messages"])} for r in train_records]
    )
    val_ds = Dataset.from_list(
        [{"text": render_qwen_chatml(r["messages"])} for r in val_records]
    )

    backend_used = "transformers+peft+trl"
    use_unsloth = importlib.util.find_spec("unsloth") is not None

    if use_unsloth:
        from unsloth import FastLanguageModel  # type: ignore

        backend_used = "unsloth"
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=args.base_model,
            max_seq_length=args.max_seq_length,
            dtype=None,
            load_in_4bit=True,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.lora_r,
            lora_alpha=args.lora_alpha,
            lora_dropout=args.lora_dropout,
            target_modules=TARGET_MODULES,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=args.seed,
        )
    else:
        from peft import (  # type: ignore
            LoraConfig,
            get_peft_model,
            prepare_model_for_kbit_training,
        )
        from transformers import (  # type: ignore
            AutoModelForCausalLM,
            AutoTokenizer,
            BitsAndBytesConfig,
        )

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=compute_dtype,
        )
        tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=True)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        base_model = AutoModelForCausalLM.from_pretrained(
            args.base_model,
            quantization_config=bnb_config,
            device_map="auto",
            torch_dtype=compute_dtype,
        )
        base_model = prepare_model_for_kbit_training(base_model)
        lora_cfg = LoraConfig(
            r=args.lora_r,
            lora_alpha=args.lora_alpha,
            lora_dropout=args.lora_dropout,
            target_modules=TARGET_MODULES,
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(base_model, lora_cfg)

    sft_config = SFTConfig(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        warmup_ratio=0.05,
        lr_scheduler_type="cosine",
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        fp16=not use_bf16,
        bf16=use_bf16,
        optim="paged_adamw_8bit",
        seed=args.seed,
        max_length=args.max_seq_length,
        dataset_text_field="text",
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=sft_config,
    )
    train_metrics = trainer.train()
    eval_metrics = trainer.evaluate()

    model.save_pretrained(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    gguf_info: dict[str, Any]
    if use_unsloth:
        model.save_pretrained_gguf(
            str(args.gguf_output.parent),
            tokenizer,
            quantization_method=args.quant_method,
        )
        gguf_info = {
            "exported": True,
            "method": "unsloth.save_pretrained_gguf",
            "quantMethod": args.quant_method,
            "outputDir": str(args.gguf_output.parent),
        }
    else:
        merged_dir = args.output_dir.parent / "sft-merged-hf"
        merged_dir.mkdir(parents=True, exist_ok=True)
        merged_model = model.merge_and_unload()
        merged_model.save_pretrained(str(merged_dir), safe_serialization=True)
        tokenizer.save_pretrained(str(merged_dir))
        gguf_info = export_merged_gguf_fallback(
            merged_dir, args.gguf_output, args.quant_method
        )

    return {
        "ok": True,
        "mode": "LIVE_GPU_QLORA_SFT",
        "backendUsed": backend_used,
        "baseModel": args.base_model,
        "adapterSavedTo": str(args.output_dir),
        "trainLoss": getattr(train_metrics, "training_loss", None),
        "evalMetrics": eval_metrics,
        "ggufExport": gguf_info,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="TryVibe Fashion Atelier — 4-bit QLoRA SFT Trainer (Qwen 2.5 Instruct)"
    )
    parser.add_argument(
        "--base-model",
        default=DEFAULT_BASE_MODEL,
        help="HuggingFace base model (default: Qwen/Qwen2.5-3B-Instruct, supports Qwen/Qwen2.5-7B-Instruct)",
    )
    parser.add_argument("--train-file", type=Path, default=DEFAULT_TRAIN_FILE)
    parser.add_argument("--val-file", type=Path, default=DEFAULT_VAL_FILE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--gguf-output", type=Path, default=DEFAULT_GGUF_OUTPUT)
    parser.add_argument("--quant-method", default="q4_k_m")
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate dataset schema, Zero-PII gate, and LoRA training plan without requiring CUDA GPU.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    train_records, train_balance = load_and_validate_chatml(args.train_file)
    val_records, val_balance = load_and_validate_chatml(args.val_file)
    runtime = probe_runtime_capabilities()

    effective_batch = max(1, args.batch_size * args.grad_accum)
    steps_per_epoch = max(1, math.ceil(len(train_records) / effective_batch))

    plan = {
        "ok": True,
        "mode": "DRY_RUN" if args.dry_run else "LIVE_TRAIN",
        "pipeline": "QLORA_4BIT_SFT",
        "baseModel": args.base_model,
        "supportedBaseModels": [
            "Qwen/Qwen2.5-3B-Instruct",
            "Qwen/Qwen2.5-7B-Instruct",
        ],
        "dataset": {
            "trainFile": str(args.train_file),
            "valFile": str(args.val_file),
            "trainRecords": len(train_records),
            "valRecords": len(val_records),
            "trainLabelBalance": train_balance,
            "valLabelBalance": val_balance,
            "zeroPiiLeaks": 0,
        },
        "qloraConfig": {
            "loadIn4Bit": True,
            "quantType": "nf4",
            "doubleQuant": True,
            "r": args.lora_r,
            "loraAlpha": args.lora_alpha,
            "loraDropout": args.lora_dropout,
            "targetModules": TARGET_MODULES,
            "maxSeqLength": args.max_seq_length,
            "epochs": args.epochs,
            "perDeviceBatchSize": args.batch_size,
            "gradAccumSteps": args.grad_accum,
            "effectiveBatchSize": effective_batch,
            "estimatedTotalSteps": steps_per_epoch * args.epochs,
            "learningRate": args.lr,
        },
        "exportPlan": {
            "adapterOutputDir": str(args.output_dir),
            "ggufOutputPath": str(args.gguf_output),
            "ggufQuantMethod": args.quant_method.upper(),
            "ollamaModelfile": str(
                REPO_ROOT / "ml" / "finetune" / "Modelfile.atelier-copilot"
            ),
        },
        "runtimeProbe": runtime,
    }

    if args.dry_run:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0

    result = run_live_sft_training(args, train_records, val_records)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
