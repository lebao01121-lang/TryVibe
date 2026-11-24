#!/usr/bin/env node
/**
 * Fashion Atelier AI Platform (v3.0) - Local TLS Certificate Generator
 *
 * Generates an X.509 v3 SAN certificate covering:
 *   DNS:localhost, DNS:admin.localhost, DNS:partner.localhost, IP:127.0.0.1, IP:::1
 *
 * Strategy:
 *   1. Prefer `mkcert` when installed on PATH.
 *   2. Fallback automatically to `openssl` (PATH or Git for Windows locations).
 *   3. Verify generated certificate SANs via `openssl x509 -noout -text`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CERTS_DIR = path.join(__dirname, "certs");
const CERT_PATH = path.join(CERTS_DIR, "atelier.crt");
const KEY_PATH = path.join(CERTS_DIR, "atelier.key");

const REQUIRED_DNS_SANS = ["localhost", "admin.localhost", "partner.localhost"];
const REQUIRED_IP_SANS = ["127.0.0.1", "::1"];

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
  "/usr/bin/openssl",
  "/usr/local/bin/openssl",
];

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options,
  });
}

function findExecutable(candidates, versionArg = "version") {
  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (!fs.existsSync(candidate)) continue;
    }
    const res = run(candidate, [versionArg]);
    if (!res.error && res.status === 0) {
      return candidate;
    }
  }
  return null;
}

function inspectCertificate(opensslBin, certPath) {
  if (!opensslBin || !fs.existsSync(certPath)) {
    return null;
  }
  const textRes = run(opensslBin, ["x509", "-in", certPath, "-noout", "-text"]);
  if (textRes.error || textRes.status !== 0) {
    return null;
  }
  const notExpiredRes = run(opensslBin, [
    "x509",
    "-in",
    certPath,
    "-noout",
    "-checkend",
    "86400",
  ]);
  const text = textRes.stdout;
  const sanMatch = text.match(/X509v3 Subject Alternative Name:\s*\n\s*(.+)/);
  const sanLine = sanMatch ? sanMatch[1].trim() : "";

  const missing = [];
  for (const dns of REQUIRED_DNS_SANS) {
    if (!sanLine.includes(`DNS:${dns}`)) {
      missing.push(`DNS:${dns}`);
    }
  }
  if (!sanLine.includes("IP Address:127.0.0.1")) {
    missing.push("IP:127.0.0.1");
  }
  if (
    !sanLine.includes("IP Address:0:0:0:0:0:0:0:1") &&
    !sanLine.includes("IP Address:::1")
  ) {
    missing.push("IP:::1");
  }

  return {
    valid: missing.length === 0 && notExpiredRes.status === 0,
    notExpired: notExpiredRes.status === 0,
    sanLine,
    missing,
  };
}

function generateWithMkcert(mkcertBin) {
  console.log(`[infra:certs] Using mkcert (${mkcertBin})...`);
  const args = [
    "-cert-file",
    CERT_PATH,
    "-key-file",
    KEY_PATH,
    ...REQUIRED_DNS_SANS,
    ...REQUIRED_IP_SANS,
  ];
  const res = run(mkcertBin, args);
  if (res.error || res.status !== 0) {
    throw new Error(
      `mkcert failed (code=${res.status}): ${res.stderr || res.stdout || res.error?.message}`,
    );
  }
}

function generateWithOpenSSL(opensslBin) {
  console.log(`[infra:certs] Using OpenSSL (${opensslBin})...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-certs-"));
  const cnfPath = path.join(tmpDir, "atelier-openssl.cnf");

  const opensslConfig = [
    "[req]",
    "default_bits = 2048",
    "prompt = no",
    "default_md = sha256",
    "distinguished_name = dn",
    "x509_extensions = v3_req",
    "",
    "[dn]",
    "C = VN",
    "ST = Ha Noi",
    "L = Ha Noi",
    "O = Fashion Atelier AI Platform",
    "OU = Local Dev Infrastructure",
    "CN = localhost",
    "",
    "[v3_req]",
    "basicConstraints = CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    "DNS.1 = localhost",
    "DNS.2 = admin.localhost",
    "DNS.3 = partner.localhost",
    "IP.1 = 127.0.0.1",
    "IP.2 = ::1",
    "",
  ].join("\n");

  try {
    fs.writeFileSync(cnfPath, opensslConfig, { encoding: "utf8" });
    const args = [
      "req",
      "-x509",
      "-nodes",
      "-days",
      "825",
      "-newkey",
      "rsa:2048",
      "-keyout",
      KEY_PATH,
      "-out",
      CERT_PATH,
      "-config",
      cnfPath,
    ];
    const res = run(opensslBin, args);
    if (res.error || res.status !== 0) {
      throw new Error(
        `openssl failed (code=${res.status}): ${res.stderr || res.stdout || res.error?.message}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  const mkcertBin = findExecutable(["mkcert"], "-version");
  const opensslBin = findExecutable(OPENSSL_CANDIDATES, "version");

  if (!force && fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    const existing = inspectCertificate(opensslBin, CERT_PATH);
    if (existing && existing.valid) {
      console.log("[infra:certs] Existing TLS certificate is valid.");
      console.log(`[infra:certs] Cert : ${CERT_PATH}`);
      console.log(`[infra:certs] Key  : ${KEY_PATH}`);
      console.log(`[infra:certs] SANs : ${existing.sanLine}`);
      return;
    }
  }

  let generator = null;
  if (mkcertBin) {
    try {
      generateWithMkcert(mkcertBin);
      generator = "mkcert";
    } catch (err) {
      console.warn(`[infra:certs] mkcert failed, falling back to OpenSSL: ${err.message}`);
    }
  }

  if (!generator) {
    if (!opensslBin) {
      console.error(
        "[infra:certs] ERROR: Neither `mkcert` nor `openssl` was found on this machine.",
      );
      process.exit(1);
    }
    generateWithOpenSSL(opensslBin);
    generator = "openssl";
  }

  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    console.error("[infra:certs] ERROR: Certificate files were not generated.");
    process.exit(1);
  }

  if (opensslBin) {
    const check = inspectCertificate(opensslBin, CERT_PATH);
    if (!check || !check.valid) {
      console.error(
        `[infra:certs] ERROR: Certificate SAN validation failed. Missing: ${check?.missing?.join(", ") || "unknown"}`,
      );
      process.exit(1);
    }
    console.log(`[infra:certs] Generated & verified via ${generator}.`);
    console.log(`[infra:certs] Cert : ${CERT_PATH}`);
    console.log(`[infra:certs] Key  : ${KEY_PATH}`);
    console.log(`[infra:certs] SANs : ${check.sanLine}`);
  } else {
    console.log(`[infra:certs] Generated via ${generator}: ${CERT_PATH}`);
  }
}

main();
