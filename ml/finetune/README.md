# Tầm Xuân Fashion Atelier — Offline QLoRA / DPO Fine-Tuning & MLOps Pipeline

Quy trình MLOps tách biệt hoàn toàn khỏi các container Web/BFF/FastAPI (`services/ai-tryon`), phục vụ chuẩn hóa dữ liệu Zero-PII, huấn luyện offline QLoRA SFT + DPO trên GPU (local NVIDIA GPU / Google Colab / Cloud GPU), xuất **GGUF (`Q4_K_M`)**, đóng gói custom Ollama model **`atelier-copilot:v1`**, kiểm thử A/B live và rollback trong 1 giây.

---

## 1. Bất biến Quyền riêng tư & Zero-PII (`rag_doc_02_tryon_privacy_15min`)

> **QUY TẮC TUYỆT ĐỐI:** Pipeline KHÔNG BAO GIỜ truy vấn, đọc, tham chiếu hay xuất bất kỳ ảnh thử đồ của khách hàng (`temp_user_images`, `atelier-private-tryon`, `tryon-raw`) hoặc số đo cơ thể thô (`heightCm`, `weightKg`, `bustCm`, `waistCm`, `hipCm`) vào bất kỳ tập dữ liệu huấn luyện nào.

- Mọi số đo vóc dáng từ đánh giá xác thực (`Verified Fit Reviews`) đều được ẩn danh hóa về **khoảng `5cm` / `5kg`** (ví dụ: `160-164cm`, `50-54kg`).
- 100% văn bản đi qua `@atelier/ai-harness` (`maskPii`) + `@atelier/observability` (`redactPiiForLog`) + **Zero-PII Gate**:
  - **Strict Regex Scan**: Email, số điện thoại Việt Nam (`+84` / `0x`), địa chỉ đường/phường/quận, `Bearer` / secret tokens, tham chiếu bucket Try-On riêng tư.
  - **Shannon Entropy Scan**: Cờ báo mọi chuỗi token có độ dài `>= 24` và `entropy > 4.2` bits/char.
  - Nếu phát hiện `> 0` rò rỉ, script tự động dừng với mã lỗi khác `0`.

---

## 2. Cấu trúc thư mục (`ml/finetune/`)

```text
ml/finetune/
├── pyproject.toml                 # Môi trường Python >= 3.11 tách biệt cho GPU fine-tune
├── train_qlora_sft.py             # QLoRA 4-bit SFT (r=16, alpha=32) + xuất GGUF Q4_K_M + --dry-run
├── train_dpo.py                   # TRL DPOTrainer (beta=0.1) trên adapter SFT + xuất GGUF Q4_K_M + --dry-run
├── Modelfile.atelier-copilot      # Ollama Modelfile chính thức cho atelier-copilot:v1 (Qwen 2.5 ChatML)
└── README.md                      # Tài liệu hướng dẫn end-to-end
```

---

## 3. Quy trình End-to-End (7 Bước)

### Bước 1 — Xuất tập dữ liệu SFT & DPO Zero-PII (`pnpm ai:export-sft`)

```bash
pnpm ai:export-sft
```

Lệnh này vừa duy trì file tương thích ngược cho Gate 3 (`artifacts/ai-sft-preference-dataset.jsonl`), vừa tạo bộ dữ liệu huấn luyện chuẩn tại `artifacts/finetune-dataset/`:

| File | Định dạng | Tỷ lệ | Nội dung |
| :--- | :--- | :---: | :--- |
| `train.jsonl` | ChatML / ShareGPT | 90% | SFT Hiệu chỉnh Size (`5cm/5kg`), trích xuất lỗi phom RMA, JSON MCP Tool Calling & phòng thủ Prompt Injection tiếng Việt |
| `val.jsonl` | ChatML / ShareGPT | 10% | Tập kiểm định phân tầng (deterministic stratified split) cho SFT |
| `dpo_train.jsonl` | TRL DPO (`prompt`, `chosen`, `rejected`) | 90% | Cặp ưu tiên từ `NHAP_AI` PO Draft (duyệt/sửa), phản hồi `👍/👎` Copilot (`rag_vector_db`) & chính sách quản trị HITL |
| `dpo_val.jsonl` | TRL DPO | 10% | Tập kiểm định cho DPO |
| `dataset-quality-report.json` | JSON Report | — | Chứng nhận `0` rò rỉ PII/entropy, thống kê khử trùng lặp SHA-256, phân bổ nhãn & đánh giá `productionReadiness` |

> **Lưu ý về độ sẵn sàng Production (`productionReadiness`):**
> Để fine-tune trọng số mô hình (weight adaptation) đạt cải thiện bền vững trong production mà không bị overfitting, hệ thống khuyến nghị tích lũy tối thiểu **`1,000 – 3,000` mẫu vận hành thực tế** (từ `ai_copilot_feedback`, `purchase_orders`, `product_reviews`, `rma`). Ở giai đoạn bootstrap ít mẫu, sử dụng **`atelier-copilot:v1`** ở Stage 1 (System Directive + tham số tối ưu trên `qwen2.5:3b`) là giải pháp an toàn và hiệu quả nhất.

---

### Bước 2 — Cài đặt môi trường GPU Offline (tách biệt khỏi web/FastAPI)

Trên máy có NVIDIA GPU (`>= 8 GB VRAM` cho 3B, `>= 16 GB VRAM` cho 7B) hoặc Google Colab / Cloud GPU:

```bash
python3.11 -m venv .venv-finetune
# Linux / macOS:
source .venv-finetune/bin/activate
# Windows PowerShell:
# .venv-finetune\Scripts\Activate.ps1

pip install --upgrade pip
pip install -e ./ml/finetune
# (Tùy chọn cho xuất GGUF qua llama.cpp nếu không dùng Unsloth)
pip install -e "./ml/finetune[gguf]"
```

---

### Bước 3 — Kiểm tra Dry-Run & Huấn luyện QLoRA SFT (`train_qlora_sft.py`)

Kiểm tra cấu trúc dữ liệu, Zero-PII Gate và cấu hình LoRA không cần GPU:

```bash
python ml/finetune/train_qlora_sft.py --dry-run
```

Chạy huấn luyện thực tế trên GPU (mặc định `Qwen/Qwen2.5-3B-Instruct`, hỗ trợ `Qwen/Qwen2.5-7B-Instruct`):

```bash
# Base 3B (khuyên dùng cho laptop / 8GB VRAM / Ollama local nhanh):
python ml/finetune/train_qlora_sft.py \
  --base-model Qwen/Qwen2.5-3B-Instruct \
  --train-file artifacts/finetune-dataset/train.jsonl \
  --val-file artifacts/finetune-dataset/val.jsonl \
  --output-dir ml/finetune/outputs/sft-adapter \
  --gguf-output ml/finetune/outputs/atelier-copilot-sft-q4_k_m.gguf

# Hoặc nâng cấp lên 7B trên Cloud GPU >= 16GB VRAM:
python ml/finetune/train_qlora_sft.py \
  --base-model Qwen/Qwen2.5-7B-Instruct \
  --output-dir ml/finetune/outputs/sft-adapter-7b \
  --gguf-output ml/finetune/outputs/atelier-copilot-7b-sft-q4_k_m.gguf
```

Thông số QLoRA chuẩn:
- Quantization: **4-bit NF4** (double quant)
- LoRA: `r=16`, `lora_alpha=32`, `lora_dropout=0.05`
- `target_modules`: `["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]`
- Backend: ưu tiên `unsloth.FastLanguageModel`, tự động fallback sang `transformers + peft + trl.SFTTrainer`.

---

### Bước 4 — Căn chỉnh sở thích DPO (`train_dpo.py`) & Xuất GGUF (`Q4_K_M`)

Kiểm tra `--dry-run` (không cần GPU):

```bash
python ml/finetune/train_dpo.py --dry-run
```

Chạy DPO (`beta=0.1`) nối tiếp từ checkpoint SFT và xuất trọng số hợp nhất `GGUF Q4_K_M`:

```bash
python ml/finetune/train_dpo.py \
  --base-model Qwen/Qwen2.5-3B-Instruct \
  --sft-adapter ml/finetune/outputs/sft-adapter \
  --train-file artifacts/finetune-dataset/dpo_train.jsonl \
  --val-file artifacts/finetune-dataset/dpo_val.jsonl \
  --beta 0.1 \
  --output-dir ml/finetune/outputs/dpo-adapter \
  --gguf-output ml/finetune/outputs/atelier-copilot-q4_k_m.gguf
```

---

### Bước 5 — Đóng gói Custom Ollama Model (`atelier-copilot:v1`)

- **Stage 1 (mặc định ngay lập tức)**: `ml/finetune/Modelfile.atelier-copilot` dùng `FROM qwen2.5:3b` kết hợp Qwen 2.5 ChatML template + System Directive tiếng Việt chuyên biệt của Tầm Xuân Atelier (`temperature 0.1`, `top_p 0.9`, `num_ctx 8192`).
- **Stage 2 (sau khi có file GGUF từ Bước 4)**: Chuyển dòng `FROM` trong `ml/finetune/Modelfile.atelier-copilot` sang:
  ```dockerfile
  FROM ./outputs/atelier-copilot-q4_k_m.gguf
  ```

Chạy build & kiểm thử smoke tiếng Việt trực tiếp với Host Ollama (`:11434`):

```bash
pnpm ai:build-model
```

Tùy chọn CLI:
```bash
node scripts/build-ollama-custom-model.mjs --model atelier-copilot:v1 --modelfile ml/finetune/Modelfile.atelier-copilot
```

---

### Bước 6 — Đánh giá A/B trực tiếp trên Host Ollama (`eval:ai:live`)

So sánh chất lượng tiếng Việt, độ chính xác gọi công cụ MCP, trích dẫn RAG và độ trễ giữa model gốc và custom model:

```bash
pnpm eval:ai:live -- --compare-models qwen2.5:3b,atelier-copilot:v1
```

---

### Bước 7 — Kích hoạt Production & Rollback trong 1 giây

#### Kích hoạt `atelier-copilot:v1`

- **PowerShell**:
  ```powershell
  $env:OLLAMA_MAIN_MODEL = "atelier-copilot:v1"
  ```
- **Bash / `.env`**:
  ```bash
  OLLAMA_MAIN_MODEL=atelier-copilot:v1
  ```
Sau đó khởi động lại `apps/mcp-copilot` (hoặc cập nhật env trong `docker-compose.prod.yml`).

#### Rollback tức thời về `qwen2.5:3b` (1 giây)

1. Kiểm tra sẵn sàng của model gốc trên Ollama:
   ```bash
   pnpm ai:build-model -- --rollback
   ```
2. Đặt lại biến môi trường:
   ```bash
   OLLAMA_MAIN_MODEL=qwen2.5:3b
   ```
   (PowerShell: `$env:OLLAMA_MAIN_MODEL = "qwen2.5:3b"`) và reload `apps/mcp-copilot`.

---

*Built with Qwen (Qwen 2.5 Instruct). Tuân thủ chính sách bảo mật 8 lớp `@atelier/ai-harness` và quy chuẩn xóa ảnh thử đồ 15 phút (`rag_doc_02_tryon_privacy_15min`).*
