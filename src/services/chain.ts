const CHAIN_RPCS: Record<number, string> = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
};

const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_URI_SELECTOR = "c87b56dd"; // keccak256("tokenURI(uint256)")[0:4]

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

interface TxReceipt {
  status: string;
  to: string | null;
  logs: RpcLog[];
}

async function rpcPost(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function getTokenURI(rpcUrl: string, contractAddress: string, tokenId: number): Promise<string | null> {
  const paddedId = tokenId.toString(16).padStart(64, "0");
  const data = `0x${TOKEN_URI_SELECTOR}${paddedId}`;
  let result: unknown;
  try {
    result = await rpcPost(rpcUrl, "eth_call", [{ to: contractAddress, data }, "latest"]);
  } catch {
    return null;
  }
  if (!result || result === "0x") return null;
  const hex = (result as string).startsWith("0x") ? (result as string).slice(2) : (result as string);
  if (hex.length < 128) return null;
  const strLen = parseInt(hex.slice(64, 128), 16);
  if (strLen === 0 || hex.length < 128 + strLen * 2) return null;
  return Buffer.from(hex.slice(128, 128 + strLen * 2), "hex").toString("utf8");
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export async function verifyMintTx(opts: {
  txHash: string;
  tokenId: number;
  ipfsCid: string;
  chainId: number;
  contractAddress: string | null;
  ownerAddress: string;
  expectedCid?: string | null;
}): Promise<VerifyResult> {
  if (!opts.contractAddress) {
    return {
      valid: false,
      reason: "CONTRACT_ADDRESS is not configured — cannot verify on-chain ownership",
    };
  }

  const rpcUrl = CHAIN_RPCS[opts.chainId];
  if (!rpcUrl) {
    return {
      valid: false,
      reason: `Unsupported chainId ${opts.chainId} — cannot verify transaction`,
    };
  }

  let receipt: TxReceipt | null;
  try {
    receipt = (await rpcPost(rpcUrl, "eth_getTransactionReceipt", [opts.txHash])) as TxReceipt | null;
  } catch (err) {
    return { valid: false, reason: `Failed to fetch tx receipt: ${String(err)}` };
  }

  if (!receipt) {
    return { valid: false, reason: "Transaction not found on chain" };
  }

  if (receipt.status !== "0x1") {
    return { valid: false, reason: "Transaction failed on chain (status != 0x1)" };
  }

  if (receipt.to?.toLowerCase() !== opts.contractAddress.toLowerCase()) {
    return {
      valid: false,
      reason: `Transaction was sent to ${receipt.to}, expected contract ${opts.contractAddress}`,
    };
  }

  const transferLog = receipt.logs.find(
    (l) =>
      l.address?.toLowerCase() === opts.contractAddress!.toLowerCase() &&
      l.topics[0]?.toLowerCase() === TRANSFER_SIG.toLowerCase() &&
      l.topics.length === 4
  );

  if (!transferLog) {
    return { valid: false, reason: "No ERC-721 Transfer event found in transaction logs" };
  }

  const onChainTokenId = parseInt(transferLog.topics[3], 16);
  if (onChainTokenId !== opts.tokenId) {
    return {
      valid: false,
      reason: `Token ID mismatch: chain emitted #${onChainTokenId}, claimed #${opts.tokenId}`,
    };
  }

  const mintRecipient = "0x" + transferLog.topics[2].slice(26);
  if (mintRecipient.toLowerCase() !== opts.ownerAddress.toLowerCase()) {
    return {
      valid: false,
      reason: `NFT minted to ${mintRecipient}, but model owner is ${opts.ownerAddress}`,
    };
  }

  if (opts.expectedCid && opts.ipfsCid !== opts.expectedCid) {
    return {
      valid: false,
      reason: `CID mismatch: submitted ${opts.ipfsCid} does not match stored model CID ${opts.expectedCid}`,
    };
  }

  const tokenUri = await getTokenURI(rpcUrl, opts.contractAddress, opts.tokenId);
  if (tokenUri === null) {
    return { valid: false, reason: "Could not read tokenURI from contract — cannot verify CID binding" };
  }
  const onChainCid = tokenUri.replace(/^ipfs:\/\//, "");
  if (onChainCid !== opts.ipfsCid) {
    return {
      valid: false,
      reason: `On-chain CID binding mismatch: contract tokenURI resolves to ${onChainCid}, submitted ${opts.ipfsCid}`,
    };
  }

  return { valid: true };
}
