# MagicBlock spike log (task 1.2)

Run started 2026-10-31T16:27:48.693Z on devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`). Private Payments API `https://payments.magicblock.app` with `cluster: "devnet-private"`; TEE RPC `https://devnet-tee.magicblock.app` (validator identity `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`), attestation in `docs/attestation-devnet.json` (verified: true).

Wallets: buyer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, escrow `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6` (base ATA `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H`), vendor1 `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` (base ATA `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`).

## Steps

| Step | Role | Call | Layer | Signature | Result |
| --- | --- | --- | --- | --- | --- |
| 2 | escrow | `getAuthToken devnet-tee.magicblock.app` |  |  | {"token":"<redacted>","expiresAt":"2026-11-30T16:27:51.473Z"} |
| 2 | vendor1 | `getAuthToken devnet-tee.magicblock.app` |  |  | {"token":"<redacted>","expiresAt":"2026-11-30T16:27:51.873Z"} |
| 2 | buyer | `getAuthToken devnet-tee.magicblock.app` |  |  | {"token":"<redacted>","expiresAt":"2026-11-30T16:27:52.272Z"} |
| 2 | buyer | `GET /v1/spl/challenge + POST /v1/spl/login` |  |  | {"token":"<redacted>"} |
| 2 | escrow | `GET /v1/spl/challenge + POST /v1/spl/login` |  |  | {"token":"<redacted>"} |
| 2 | vendor1 | `GET /v1/spl/challenge + POST /v1/spl/login` |  |  | {"token":"<redacted>"} |
| 0 | escrow | `GET /v1/spl/private-balance` |  |  | {"address":"EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","ata":"7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H","location":"ephemeral","balance":"510000","delegation":{"status":"delegated","validator":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","endpoint":"https://devnet-tee.magicblock.app"},"onboarding":"already delegated; no onboarding deposit"} |
| 0 | vendor1 | `GET /v1/spl/private-balance` |  |  | {"address":"ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","ata":"CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf","location":"ephemeral","balance":"260000","delegation":{"status":"delegated","validator":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","endpoint":"https://devnet-tee.magicblock.app"},"onboarding":"already delegated; no onboarding deposit"} |
| 3a | buyer | `POST /v1/spl/deposit` | base | [5PVipfY23r99vGqegE82oWNvqp8ZhrVmpcCNaCgxtkyfcAX7PEB55TyQ26iTbe22z31jYLGPKmKcN2PNeYxjbBTn](https://explorer.solana.com/tx/5PVipfY23r99vGqegE82oWNvqp8ZhrVmpcCNaCgxtkyfcAX7PEB55TyQ26iTbe22z31jYLGPKmKcN2PNeYxjbBTn?cluster=devnet) | {"reused":"landed in an earlier attempt of this run; not repeated"} |
| 3b | buyer | `POST /v1/spl/transfer` | ephemeral | `mYYfAWQES3beETytbLALHnyutRzewGgHgHXRSoAemSSJispYvg4JXttfniVgZHVkPa3CELvm5vQm1yTZVx9P6zN` | {"reused":"landed in an earlier attempt of this run; not repeated"} |
| 3c | escrow | `GET /v1/spl/private-balance` |  |  | {"address":"EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","ata":"7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H","location":"ephemeral","balance":"510000","delegation":{"status":"delegated","validator":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","endpoint":"https://devnet-tee.magicblock.app"}} |
| 4 | escrow | `POST /v1/spl/transfer` | ephemeral | `2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN` | {"confirmed":true,"confirmationRequiresAuthToken":true} |
| 5 | vendor1 | `GET /v1/spl/private-balance` |  |  | {"address":"ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","ata":"CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf","location":"ephemeral","balance":"760000","delegation":{"status":"delegated","validator":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","endpoint":"https://devnet-tee.magicblock.app"},"referenceIdsVisible":"none: no clientRefId, memo or sender appears in the response"} |
| 5b | escrow | `GET /v1/spl/private-balance` |  |  | {"address":"EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","ata":"7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H","location":"ephemeral","balance":"10000","delegation":{"status":"delegated","validator":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","endpoint":"https://devnet-tee.magicblock.app"}} |
| 6 | vendor1 | `POST /v1/spl/withdraw` | base | [3CX86jpH3BEWJEYCiU5LBA52mbPRmcS2ZwMAWPo3bJP5sjc7rxbxUXUrng7VMfcNUQ54EGy4QGcum4Ga4k9turME](https://explorer.solana.com/tx/3CX86jpH3BEWJEYCiU5LBA52mbPRmcS2ZwMAWPo3bJP5sjc7rxbxUXUrng7VMfcNUQ54EGy4QGcum4Ga4k9turME?cluster=devnet) | {"confirmed":true,"confirmationRequiresAuthToken":false} |
| 6b | observer | `getTokenAccountBalance vendor1 base ATA` |  |  | {"before":"540000","after":"540000","arrived":false} |

Ephemeral signatures are executed inside the TEE validator and are not on the public ledger; no public explorer shows them. Base signatures link to the Solana explorer on devnet.

## Signatures

Machine-readable, one per line: `layer label signature`.

```
base attempt 1 buyer deposit 2 USDC (private), API send reported it expired although it had landed 2oZwKoyd3QtAnsLtvm6CzgxXvawBoRSH8kWD41ijZotFEjfa9GTVT3Nr39mGTstiajQ2oV3tk6uT9GGCeuisiAvL
base attempt 2 buyer deposit 2 USDC (private) 2GqSZzaPYiXjKnzzEtqXoNbbJNCjigsVyuN8wvBDuUz1JV6wuGLDJ8AxNTPY5kYqnMVJWkRCDMNUDWkF5hyxyh22
base attempt 3 buyer deposit 2 USDC (private) mYF6bQ6Bf8cuy6opesm16PuZ2jefAJJjTShUs7yoLBCrUrQ7vCDAjjQcfd28rkukp8zBM1QFsJpHeWXyzY3fUGY
base setup, buyer sends 0.05 USDC to the escrow and vendor1 base ATAs (public SPL transfer, outside the spike flow) w93wW2Gvpv7XzfGpo6abeBuKV58pqiZG7UU6ndDZ3QNt1wu1cs482M6bPhz2hVL333MKvMYqWog4vSyssZS9Rry
base step 0 escrow onboarding deposit 0.01 USDC (private) qJAZUeFdwwrnCXkYud2YWFGBfgRRTQD4YQLhLZ63TtETPUqmbrqCoWyFaYUKcEaK7ptoRM7h48QRBzTQYob7cv4
base step 0 vendor1 onboarding deposit 0.01 USDC (private) 5Uocbn3cwpSS6cvDoaBc1tXnwCZ8FeXouui5JUPK9ZxLZxwmQ6epXpwcyavTD1EotEWtMEk5CFvmX55wwhNADYPX
base pass 1 vendor1 withdraw 0.25 USDC to base ATA (request) 4J6aWqC9tzxQyebWyGfZaqM76AtquKquJ6VfJb2dsmFRkAZ7XUoPGcZCtZNeM4ncMBb7Dq4ow7GJJwBm6YHU9Jii
base buyer deposit 2 USDC (private) 5PVipfY23r99vGqegE82oWNvqp8ZhrVmpcCNaCgxtkyfcAX7PEB55TyQ26iTbe22z31jYLGPKmKcN2PNeYxjbBTn
base vendor1 withdraw 0.25 USDC to base ATA 3CX86jpH3BEWJEYCiU5LBA52mbPRmcS2ZwMAWPo3bJP5sjc7rxbxUXUrng7VMfcNUQ54EGy4QGcum4Ga4k9turME
ephemeral pass 1 escrow → vendor1 0.5 USDC private, ref 2001, delay 5–30 s HkLhGamKri8TLU7MCAoxggWr7TthinnQHCMN9DpUG2DA9xgHLzXkhqAzQEADyBHSsHB36BvnHJxk8CWUnncTRVn
ephemeral buyer → escrow 1 USDC private, ref 1001 mYYfAWQES3beETytbLALHnyutRzewGgHgHXRSoAemSSJispYvg4JXttfniVgZHVkPa3CELvm5vQm1yTZVx9P6zN
ephemeral escrow → vendor1 0.5 USDC private, ref 2001, delay 5–30 s 2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN
```

The escrow → vendor1 private transfer (step 4) was submitted to the ephemeral layer with signature `2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN`. It produced no base-layer signature of its own.

## Ephemeral transactions as read through the TEE RPC

Each ephemeral signature fetched with `getTransaction` (jsonParsed) using the TEE login of the buyer, the escrow and vendor1 in turn.

### pass 1 escrow → vendor1 0.5 USDC private, ref 2001, delay 5–30 s

Signature `HkLhGamKri8TLU7MCAoxggWr7TthinnQHCMN9DpUG2DA9xgHLzXkhqAzQEADyBHSsHB36BvnHJxk8CWUnncTRVn`

- buyer: found, err null, 0 log lines, account keys none, token balances []
- escrow: found, err null, 0 log lines, account keys none, token balances []
- vendor1: found, err null, 0 log lines, account keys none, token balances []

### buyer → escrow 1 USDC private, ref 1001

Signature `mYYfAWQES3beETytbLALHnyutRzewGgHgHXRSoAemSSJispYvg4JXttfniVgZHVkPa3CELvm5vQm1yTZVx9P6zN`

- buyer: found, err null, 0 log lines, account keys none, token balances []
- escrow: found, err null, 0 log lines, account keys none, token balances []
- vendor1: found, err null, 0 log lines, account keys none, token balances []

### escrow → vendor1 0.5 USDC private, ref 2001, delay 5–30 s

Signature `2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN`

- buyer: found, err null, 0 log lines, account keys none, token balances []
- escrow: found, err null, 0 log lines, account keys none, token balances []
- vendor1: found, err null, 0 log lines, account keys none, token balances []

## Observer notes (Helius RPC, base layer)

Every base-layer signature produced by the run, plus every base-layer signature in the run's window that touched the escrow wallet, the vendor1 wallet, their base ATAs or the buyer's base ATA.

### attempt 1 buyer deposit 2 USDC (private), API send reported it expired although it had landed

Signature [2oZwKoyd3QtAnsLtvm6CzgxXvawBoRSH8kWD41ijZotFEjfa9GTVT3Nr39mGTstiajQ2oV3tk6uT9GGCeuisiAvL](https://explorer.solana.com/tx/2oZwKoyd3QtAnsLtvm6CzgxXvawBoRSH8kWD41ijZotFEjfa9GTVT3Nr39mGTstiajQ2oV3tk6uT9GGCeuisiAvL?cluster=devnet), slot 517187450, 2026-10-31T15:59:49.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Signers: `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; fee payer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 2000000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`
- Token balance deltas: `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` (owner `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`) -2000000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 2000000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): no; carries the 0.5 USDC amount (500000): no

### attempt 2 buyer deposit 2 USDC (private)

Signature [2GqSZzaPYiXjKnzzEtqXoNbbJNCjigsVyuN8wvBDuUz1JV6wuGLDJ8AxNTPY5kYqnMVJWkRCDMNUDWkF5hyxyh22](https://explorer.solana.com/tx/2GqSZzaPYiXjKnzzEtqXoNbbJNCjigsVyuN8wvBDuUz1JV6wuGLDJ8AxNTPY5kYqnMVJWkRCDMNUDWkF5hyxyh22?cluster=devnet), slot 517188319, 2026-10-31T16:03:16.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Signers: `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; fee payer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 2000000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`
- Token balance deltas: `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` (owner `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`) -2000000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 2000000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): no; carries the 0.5 USDC amount (500000): no

### attempt 3 buyer deposit 2 USDC (private)

Signature [mYF6bQ6Bf8cuy6opesm16PuZ2jefAJJjTShUs7yoLBCrUrQ7vCDAjjQcfd28rkukp8zBM1QFsJpHeWXyzY3fUGY](https://explorer.solana.com/tx/mYF6bQ6Bf8cuy6opesm16PuZ2jefAJJjTShUs7yoLBCrUrQ7vCDAjjQcfd28rkukp8zBM1QFsJpHeWXyzY3fUGY?cluster=devnet), slot 517189071, 2026-10-31T16:06:15.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Signers: `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; fee payer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 2000000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`
- Token balance deltas: `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` (owner `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`) -2000000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 2000000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): no; carries the 0.5 USDC amount (500000): no

### setup, buyer sends 0.05 USDC to the escrow and vendor1 base ATAs (public SPL transfer, outside the spike flow)

Signature [w93wW2Gvpv7XzfGpo6abeBuKV58pqiZG7UU6ndDZ3QNt1wu1cs482M6bPhz2hVL333MKvMYqWog4vSyssZS9Rry](https://explorer.solana.com/tx/w93wW2Gvpv7XzfGpo6abeBuKV58pqiZG7UU6ndDZ3QNt1wu1cs482M6bPhz2hVL333MKvMYqWog4vSyssZS9Rry?cluster=devnet), slot 517192534, 2026-10-31T16:20:05.000Z

- Program ids: `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `11111111111111111111111111111111`
- Signers: `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; fee payer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transfer 50000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; transfer 50000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`
- Token balance deltas: `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` (owner `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`) -100000; `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H` (owner `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6`) 50000; `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` (owner `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`) 50000
- Recipients: `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H`, `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`
- Memo instruction: none
- Fee transfers (system transfer instructions): none
- Names vendor1 (wallet or base ATA): `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`, `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`; carries the 0.5 USDC amount (500000): no

### step 0 escrow onboarding deposit 0.01 USDC (private)

Signature [qJAZUeFdwwrnCXkYud2YWFGBfgRRTQD4YQLhLZ63TtETPUqmbrqCoWyFaYUKcEaK7ptoRM7h48QRBzTQYob7cv4](https://explorer.solana.com/tx/qJAZUeFdwwrnCXkYud2YWFGBfgRRTQD4YQLhLZ63TtETPUqmbrqCoWyFaYUKcEaK7ptoRM7h48QRBzTQYob7cv4?cluster=devnet), slot 517192955, 2026-10-31T16:21:45.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Signers: `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6`; fee payer `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 10000 from `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6`
- Token balance deltas: `7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H` (owner `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6`) -10000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 10000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): no; carries the 0.5 USDC amount (500000): no

### step 0 vendor1 onboarding deposit 0.01 USDC (private)

Signature [5Uocbn3cwpSS6cvDoaBc1tXnwCZ8FeXouui5JUPK9ZxLZxwmQ6epXpwcyavTD1EotEWtMEk5CFvmX55wwhNADYPX](https://explorer.solana.com/tx/5Uocbn3cwpSS6cvDoaBc1tXnwCZ8FeXouui5JUPK9ZxLZxwmQ6epXpwcyavTD1EotEWtMEk5CFvmX55wwhNADYPX?cluster=devnet), slot 517192970, 2026-10-31T16:21:48.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Signers: `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`; fee payer `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 10000 from `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`
- Token balance deltas: `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` (owner `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`) -10000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 10000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`; carries the 0.5 USDC amount (500000): no

### pass 1 vendor1 withdraw 0.25 USDC to base ATA (request)

Signature [4J6aWqC9tzxQyebWyGfZaqM76AtquKquJ6VfJb2dsmFRkAZ7XUoPGcZCtZNeM4ncMBb7Dq4ow7GJJwBm6YHU9Jii](https://explorer.solana.com/tx/4J6aWqC9tzxQyebWyGfZaqM76AtquKquJ6VfJb2dsmFRkAZ7XUoPGcZCtZNeM4ncMBb7Dq4ow7GJJwBm6YHU9Jii?cluster=devnet), slot 517193715, 2026-10-31T16:24:47.000Z

- Program ids: `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `11111111111111111111111111111111`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Signers: `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`; fee payer `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): none
- Token balance deltas: none
- Recipients: none
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`; carries the 0.5 USDC amount (500000): no

### buyer deposit 2 USDC (private)

Signature [5PVipfY23r99vGqegE82oWNvqp8ZhrVmpcCNaCgxtkyfcAX7PEB55TyQ26iTbe22z31jYLGPKmKcN2PNeYxjbBTn](https://explorer.solana.com/tx/5PVipfY23r99vGqegE82oWNvqp8ZhrVmpcCNaCgxtkyfcAX7PEB55TyQ26iTbe22z31jYLGPKmKcN2PNeYxjbBTn?cluster=devnet), slot 517192984, 2026-10-31T16:21:52.000Z

- Program ids: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `11111111111111111111111111111111`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Signers: `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`; fee payer `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): transferChecked 2000000 from `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` to `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` by `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`
- Token balance deltas: `4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79` (owner `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`) -2000000; `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) 2000000
- Recipients: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r`
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): no; carries the 0.5 USDC amount (500000): no

### vendor1 withdraw 0.25 USDC to base ATA

Signature [3CX86jpH3BEWJEYCiU5LBA52mbPRmcS2ZwMAWPo3bJP5sjc7rxbxUXUrng7VMfcNUQ54EGy4QGcum4Ga4k9turME](https://explorer.solana.com/tx/3CX86jpH3BEWJEYCiU5LBA52mbPRmcS2ZwMAWPo3bJP5sjc7rxbxUXUrng7VMfcNUQ54EGy4QGcum4Ga4k9turME?cluster=devnet), slot 517194523, 2026-10-31T16:28:00.000Z

- Program ids: `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `11111111111111111111111111111111`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Signers: `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`; fee payer `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, fee 5000 lamports
- Token amounts (parsed spl-token transfers): none
- Token balance deltas: none
- Recipients: none
- Memo instruction: none
- Fee transfers (system transfer instructions): 500000 lamports `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` → `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`
- Names vendor1 (wallet or base ATA): `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`; carries the 0.5 USDC amount (500000): no

### touched vendor1 wallet

Signature [5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp](https://explorer.solana.com/tx/5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp?cluster=devnet), slot 517194528, 2026-10-31T16:28:01.000Z

- Program ids: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`, `11111111111111111111111111111111`, `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Signers: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`; fee payer `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, fee 32200 lamports
- Token amounts (parsed spl-token transfers): transferChecked 250000 from `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` to `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` by `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`
- Token balance deltas: `TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r` (owner `EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG`) -250000; `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf` (owner `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`) 250000
- Recipients: `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`
- Memo instruction: none
- Fee transfers (system transfer instructions): 391040 lamports `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` → `29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv`; 391040 lamports `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` → `29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv`
- Names vendor1 (wallet or base ATA): `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm`, `CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf`; carries the 0.5 USDC amount (500000): no

## Summary for Gate R

- Step 4 base-layer signatures: none.
- Base-layer transactions in the window that name vendor1 without vendor1 signing them (setup excluded): touched vendor1 wallet 5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp.
- Base-layer transactions in the window that name both the escrow and vendor1: setup, buyer sends 0.05 USDC to the escrow and vendor1 base ATAs (public SPL transfer, outside the spike flow) w93wW2Gvpv7XzfGpo6abeBuKV58pqiZG7UU6ndDZ3QNt1wu1cs482M6bPhz2hVL333MKvMYqWog4vSyssZS9Rry.
- Base-layer transactions in the window carrying the 0.5 USDC amount (setup excluded): none.
- Transactions signed by vendor1 itself (its onboarding deposit and its withdrawal) name vendor1 by construction; they show the vault as counterparty, not the escrow.
- vendor1 private balance after settlement: 760000 base units.
