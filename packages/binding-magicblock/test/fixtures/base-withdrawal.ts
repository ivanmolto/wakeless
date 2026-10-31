// The validator-signed vault → vendor1 release observed on devnet (docs/spike-log.md,
// "touched vendor1 wallet", 5XKE2bt3…319bp), reduced to the fields the observer reads.
export const BASE_WITHDRAWAL = {
  slot: 517194528,
  blockTime: 1793464081,
  transaction: {
    message: {
      accountKeys: [
        { pubkey: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", signer: true, writable: true },
        { pubkey: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r", signer: false, writable: true },
        { pubkey: "CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf", signer: false, writable: true },
        { pubkey: "29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv", signer: false, writable: true },
        { pubkey: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG", signer: false, writable: false },
        { pubkey: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", signer: false, writable: false },
        { pubkey: "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", signer: false, writable: false },
        { pubkey: "11111111111111111111111111111111", signer: false, writable: false },
        { pubkey: "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2", signer: false, writable: false },
        { pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", signer: false, writable: false },
        { pubkey: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", signer: false, writable: false },
      ],
      instructions: [
        { programId: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", accounts: [], data: "3" },
        { programId: "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", accounts: [], data: "4" },
        { programId: "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2", accounts: [], data: "5" },
      ],
    },
  },
  meta: {
    err: null,
    fee: 32200,
    innerInstructions: [
      {
        index: 0,
        instructions: [
          { program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", destination: "29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv", lamports: 391040 } } },
        ],
      },
      {
        index: 2,
        instructions: [
          { program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", destination: "29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv", lamports: 391040 } } },
          {
            program: "spl-token",
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            parsed: {
              type: "transferChecked",
              info: { source: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r", destination: "CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf", authority: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", tokenAmount: { amount: "250000", decimals: 6, uiAmount: 0.25, uiAmountString: "0.25" } },
            },
          },
        ],
      },
    ],
    preTokenBalances: [
      { accountIndex: 1, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", owner: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG", uiTokenAmount: { amount: "5020000", decimals: 6 } },
      { accountIndex: 2, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", owner: "ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm", uiTokenAmount: { amount: "540000", decimals: 6 } },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", owner: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG", uiTokenAmount: { amount: "4770000", decimals: 6 } },
      { accountIndex: 2, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", owner: "ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm", uiTokenAmount: { amount: "790000", decimals: 6 } },
    ],
  },
};
