// Classifies a signing activity as mainnet / testnet / unknown.
//
// What can be known:
//  - ETH_SEND_* and SOL_SEND_* activities carry a CAIP-2 chain id.
//  - SIGN_TRANSACTION(_V2) with an Ethereum transaction: the chain id is decoded from the
//    unsigned transaction (EIP-1559/2930 typed txs and EIP-155 legacy txs).
//  - Raw payload signatures (hashes, EIP-712, messages) and Solana SIGN_TRANSACTION do not
//    include the network, so they are reported as "unknown".

import * as viemChains from "viem/chains";
import { parseTransaction, type Hex } from "viem";
import { config } from "./config.js";
import type { Activity } from "./turnkey.js";

export type NetworkClass = "mainnet" | "testnet" | "unknown";

const chainInfo = new Map<number, { name: string; testnet: boolean }>();
for (const c of Object.values(viemChains) as any[]) {
  if (c && typeof c.id === "number" && !chainInfo.has(c.id)) {
    chainInfo.set(c.id, { name: c.name, testnet: c.testnet === true });
  }
}
for (const id of config.extraTestnetChainIds) chainInfo.set(id, { name: chainInfo.get(id)?.name ?? `eip155:${id}`, testnet: true });
for (const id of config.extraMainnetChainIds) chainInfo.set(id, { name: chainInfo.get(id)?.name ?? `eip155:${id}`, testnet: false });

const SOLANA = {
  mainnet: ["mainnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  testnet: ["devnet", "testnet", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"],
};

export interface NetworkResult {
  class: NetworkClass;
  label: string; // e.g. "Ethereum", "Sepolia", "solana:devnet", "unknown (raw payload)"
}

function fromEvmChainId(id: number): NetworkResult {
  const info = chainInfo.get(id);
  if (!info) return { class: "unknown", label: `eip155:${id} (unclassified, set TESTNET_CHAIN_IDS / MAINNET_CHAIN_IDS)` };
  return { class: info.testnet ? "testnet" : "mainnet", label: info.name };
}

function fromCaip2(caip2: string): NetworkResult {
  const [ns, ref] = caip2.split(":");
  if (ns === "eip155") return fromEvmChainId(Number(ref));
  if (ns === "solana") {
    if (SOLANA.mainnet.some((m) => ref.startsWith(m))) return { class: "mainnet", label: "Solana" };
    if (SOLANA.testnet.some((m) => ref.startsWith(m))) return { class: "testnet", label: "Solana devnet/testnet" };
  }
  return { class: "unknown", label: caip2 };
}

function findKey(obj: any, key: string, depth = 0): any {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function classifyActivity(a: Activity): NetworkResult {
  const intent: any = a.intent ?? {};

  const caip2 = findKey(intent, "caip2");
  if (typeof caip2 === "string") return fromCaip2(caip2);

  const tx = intent.signTransactionIntentV2 ?? intent.signTransactionIntent;
  if (tx?.unsignedTransaction) {
    if (String(tx.type).includes("ETHEREUM")) {
      try {
        const hex = (tx.unsignedTransaction.startsWith("0x") ? tx.unsignedTransaction : `0x${tx.unsignedTransaction}`) as Hex;
        const parsed: any = parseTransaction(hex);
        if (parsed.chainId) return fromEvmChainId(Number(parsed.chainId));
      } catch {
        /* fall through */
      }
      return { class: "unknown", label: "unknown (EVM tx without chain id)" };
    }
    return { class: "unknown", label: `unknown (${String(tx.type).replace("TRANSACTION_TYPE_", "").toLowerCase()} tx)` };
  }

  return { class: "unknown", label: "unknown (raw payload / message)" };
}

/** Number of signatures produced by one activity (batch payload signing counts each payload). */
export function signatureCount(a: Activity): number {
  const payloads = (a.intent as any)?.signRawPayloadsIntent?.payloads;
  return Array.isArray(payloads) && payloads.length > 0 ? payloads.length : 1;
}
