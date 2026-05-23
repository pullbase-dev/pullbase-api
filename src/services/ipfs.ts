const PINATA_JWT = process.env.PINATA_JWT;
const DEV_STUB_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const DEV_STUB_FILE_CID = "bafkreihdwdcefgh4dqkjv67uzcmw37nwokasqzidwv4u3afxfhvntfm5dy";

export interface ModelMetadata {
  name: string;
  description?: string | null;
  framework: string;
  license: string;
  task: string;
  parameterCount?: string | null;
  ownerAddress: string;
  fileCid?: string | null;
  tags?: string[];
}

export interface PinResult {
  cid: string;
  metadataUrl: string;
  isDev: boolean;
  fileCid?: string | null;
}

export async function pinFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ cid: string; isDev: boolean }> {
  if (!PINATA_JWT) {
    return { cid: DEV_STUB_FILE_CID, isDev: true };
  }

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append("file", blob, filename);
  formData.append("pinataMetadata", JSON.stringify({ name: filename }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata file pin error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { IpfsHash: string };
  return { cid: json.IpfsHash, isDev: false };
}

export interface DatasetMetadata {
  name: string;
  description?: string | null;
  format: string;
  license: string;
  task: string;
  language?: string | null;
  ownerAddress: string;
  fileCid?: string | null;
  tags?: string[];
}

export async function pinDatasetMetadata(metadata: DatasetMetadata): Promise<PinResult> {
  if (!PINATA_JWT) {
    return {
      cid: DEV_STUB_CID,
      metadataUrl: `ipfs://${DEV_STUB_CID}`,
      isDev: true,
      fileCid: metadata.fileCid ?? null,
    };
  }

  const payload = {
    pinataContent: {
      name: metadata.name,
      description: metadata.description ?? "",
      format: metadata.format,
      license: metadata.license,
      task: metadata.task,
      language: metadata.language ?? null,
      ownerAddress: metadata.ownerAddress,
      model_cid: metadata.fileCid ?? null,
      fileCid: metadata.fileCid ?? null,
      tags: metadata.tags ?? [],
      createdAt: new Date().toISOString(),
    },
    pinataMetadata: {
      name: `pullbase-dataset-${metadata.name}`,
    },
  };

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { IpfsHash: string };
  const cid = json.IpfsHash;
  return { cid, metadataUrl: `ipfs://${cid}`, isDev: false, fileCid: metadata.fileCid ?? null };
}

export async function pinModelMetadata(metadata: ModelMetadata): Promise<PinResult> {
  if (!PINATA_JWT) {
    return {
      cid: DEV_STUB_CID,
      metadataUrl: `ipfs://${DEV_STUB_CID}`,
      isDev: true,
      fileCid: metadata.fileCid ?? null,
    };
  }

  const payload = {
    pinataContent: {
      name: metadata.name,
      description: metadata.description ?? "",
      framework: metadata.framework,
      license: metadata.license,
      task: metadata.task,
      parameterCount: metadata.parameterCount ?? null,
      ownerAddress: metadata.ownerAddress,
      model_cid: metadata.fileCid ?? null,
      fileCid: metadata.fileCid ?? null,
      tags: metadata.tags ?? [],
      createdAt: new Date().toISOString(),
    },
    pinataMetadata: {
      name: `pullbase-model-${metadata.name}`,
    },
  };

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { IpfsHash: string };
  const cid = json.IpfsHash;
  return {
    cid,
    metadataUrl: `ipfs://${cid}`,
    isDev: false,
    fileCid: metadata.fileCid ?? null,
  };
}
