# Vocabulary of the relationship-terms layer

The layer (`packages/vendor/src/terms/`, `docs/TERMS.md`, the README's section) uses four terms and no others for what it computes:

| Term | What it names |
| --- | --- |
| **standard price** | The route's price for an unknown buyer: `amountPerRoute` in the vendor middleware |
| **risk premium** | Basis points added to the standard price for an active incident (`close_with_unpaid`, `repeated_exceeds_deposit`) |
| **relationship capital** | Basis points taken off the standard price, earned at 250 per clean period, capped at 2500 |
| **funding requirement** | `extra.minDeposit`: the deposit the vendor asks for, in calls' worth of the price |

Forbidden, anywhere in those files and in `README.md`: `score`, `rating`, `reputation score`, `trust level`, `collateral`, `credit score`. `packages/vendor/test/terms/vocabulary.test.ts` is the CI grep: it fails the build on any of them.

Why the words matter: there is no canonical "is this buyer good". There are only relationships, each private to the party that earned it. A score or a rating names a portable number about a buyer; relationship capital names what one vendor learned from one buyer, and it is not portable by design (briefing §2b, §3c). Capital is never rendered as a standing balance, badge or tier; it appears only as a line on a terms receipt, with its evidence, at the moment it changes a term.
