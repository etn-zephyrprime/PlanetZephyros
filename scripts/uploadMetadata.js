const pinataSDK = require('@pinata/sdk');

const pinata = new pinataSDK({ pinataJWTKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI1ZGNkODNkMC0yNTIxLTQzNDgtOWRhNi0zOWZkYTUyNjQwYTgiLCJlbWFpbCI6Imlkb250ZG9jcnlwdG9Ab3V0bG9vay5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJGUkExIn0seyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiN2RkOGMzOWQ0NTAwMDhhOTRiMzMiLCJzY29wZWRLZXlTZWNyZXQiOiI4ZDE1NjYwNjM5NjEzZDNiNTk5MmNkYWI5ZGExMTY5NjkxMzAwNzc4MmRlM2EwZTIwZTEzMTI1MTZhOGMyYjZlIiwiZXhwIjoxODA1ODAyMzQ2fQ.J4F_zxhtnVhKNnPX-9FXLn91saDUvcoSbBklIDn7Zas' });

async function uploadSingleMetadata(tokenId, metadataObject) {
  const options = {
    pinataMetadata: {
      name: tokenId.toString()   // This sets a display name in Pinata dashboard; the actual IPFS path is just the raw CID (no filename/extension by default)
    },
    pinataOptions: {
      cidVersion: 1
    }
  };

  try {
    const result = await pinata.pinJSONToIPFS(metadataObject, options);
    console.log(`Token #${tokenId} pinned successfully!`);
    console.log('IPFS Hash (use this!):', result.IpfsHash);
    console.log('Token URI:', `ipfs://${result.IpfsHash}`);
    console.log('Gateway test URL:', `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`);
    return result.IpfsHash;
  } catch (error) {
    console.error(`Error pinning token #${tokenId}:`, error);
  }
}

// Define all 9 metadata objects separately
const metadatas = [
  {
    name: "Erevos #1",
    description: "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
    image: "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/1.png",
    external_url: "https://planetetn.org/zephyros",
    attributes: [
      { trait_type: "Edition", value: "1 of 9" },
      { trait_type: "Revenue Share", value: "1/9 of Aether Scions royalties" },
      { trait_type: "Reflection Pool Allocation", value: "50%" },
      { trait_type: "Collection Utility", value: "Passive revenue from 198 Aether Scions" },
      { trait_type: "Royalty Percentage", value: "10%" },
      { trait_type: "Role", value: "Primordial Guardian" },
      { trait_type: "Rarity Tier", value: "Genesis" }
    ]
  },
  // Repeat the pattern for #2 through #9 (change name, image number, Edition value)
  {
    name: "Erevos #2",
    description: "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
    image: "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/2.png",
    external_url: "https://planetetn.org/zephyros",
    attributes: [
      { trait_type: "Edition", value: "2 of 9" },
      { trait_type: "Revenue Share", value: "1/9 of Aether Scions royalties" },
      { trait_type: "Reflection Pool Allocation", value: "50%" },
      { trait_type: "Collection Utility", value: "Passive revenue from 198 Aether Scions" },
      { trait_type: "Royalty Percentage", value: "10%" },
      { trait_type: "Role", value: "Primordial Guardian" },
      { trait_type: "Rarity Tier", value: "Genesis" }
    ]
  },
  {"name": "Erevos #3",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/3.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "3 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {"name": "Erevos #4",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/4.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "4 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {"name": "Erevos #5",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/5.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "5 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {
  "name": "Erevos #6",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/6.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "6 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {
  "name": "Erevos #7",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/7.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "7 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {
  "name": "Erevos #8",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/8.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "8 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
  ]
  },
  {
  "name": "Erevos #9",
  "description": "In the Aether Scions saga, the nine Erevos NFTs stand as primordial guardians — each bearing equal dominion over the revenue streams of the 198 Aether Scions collection. Their holders inherit 1/9th of all primary mint proceeds and secondary royalties (10%), channeled through the reflection mechanism: 50% to Erevos wallets, 40% to CORE buy & burns, 10% to Club Watch Holders. Only 9 will ever exist. Claim your share of the silent world's legacy.",
  "image": "https://ipfs.io/ipfs/bafybeihx7fx7lzi5jxa5tl5eqh37vfsu4kxvvanjyy3q4xac4bawdcf3ty/9.png",
  "external_url": "https://planetetn.org/zephyros",
  "attributes": [
    {
      "trait_type": "Edition",
      "value": "9 of 9"
    },
    {
      "trait_type": "Revenue Share",
      "value": "1/9 of Aether Scions royalties"
    },
    {
      "trait_type": "Reflection Pool Allocation",
      "value": "50%"
    },
    {
      "trait_type": "Collection Utility",
      "value": "Passive revenue from 198 Aether Scions"
    },
    {
      "trait_type": "Royalty Percentage",
      "value": "10%"
    },
    {
      "trait_type": "Role",
      "value": "Primordial Guardian"
    },
    {
      "trait_type": "Rarity Tier",
      "value": "Genesis"
    }
    ]
  }
];

// Upload all of them in a loop
async function uploadAll() {
  for (let i = 0; i < metadatas.length; i++) {
    const tokenId = i + 1;
    const meta = metadatas[i];
    await uploadSingleMetadata(tokenId, meta);
    // Optional: add a small delay if rate-limited (rare for 9 items)
    // await new Promise(r => setTimeout(r, 1000));
  }
  console.log("All 9 Erevos metadata pinned!");
}

uploadAll().catch(console.error);

uploadSingleMetadata(1, exampleMetadata);

// To upload many: loop over your JSON files or array
// e.g.:
// for (let id = 1; id <= 10; id++) {
//   const meta = JSON.parse(fs.readFileSync(`./metadata/${id}.json`));
//   await uploadSingleMetadata(id, meta);
// }