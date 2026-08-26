# Sample data

Fictional, synthetic documents so anyone can try HEAL.AI end-to-end without real
health information. Nothing here is a real person, plan, or bill.

| File | Use it to demo |
|------|----------------|
| `sample_policy.pdf` | Upload as your **insurance policy** — extracts deductible, OOP max, copays, coinsurance. |
| `sample_bill_clean.pdf` | A bill billed **correctly** against the policy — the checker should find no errors. |
| `sample_bill_overcharged.pdf` | A bill with **3 planted errors** (duplicate ER visit, a preventive service billed at full price, a wrong ER copay) — the checker flags them and drafts a dispute. |

Suggested demo flow: upload `sample_policy.pdf`, then run the bill checker on
`sample_bill_overcharged.pdf` against it, then generate the dispute letter.

Regenerate after editing: `python backend/sample_data/generate_samples.py`
