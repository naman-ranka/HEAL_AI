"""
Generate synthetic sample documents for demoing HEAL.AI.

Everything here is FAKE and internally consistent so the demo tells a story:
  - sample_policy.pdf          : a fictional PPO plan
  - sample_bill_clean.pdf      : a bill that is billed correctly against the plan
  - sample_bill_overcharged.pdf: a bill with planted errors the checker should catch
                                 (duplicate line item + a covered service billed at
                                  full price + a wrong copay), so the dispute path fires.

No real patient data. Names/IDs are invented.

Run:  python backend/sample_data/generate_samples.py
Requires PyMuPDF (already in requirements.txt).
"""

import os
import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))


def _write_pdf(filename: str, title: str, lines: list[str]) -> None:
    doc = fitz.open()
    page = doc.new_page()
    y = 60
    page.insert_text((60, y), title, fontsize=16, fontname="helv")
    y += 30
    for line in lines:
        if y > 760:  # new page
            page = doc.new_page()
            y = 60
        page.insert_text((60, y), line, fontsize=11, fontname="helv")
        y += 18
    out = os.path.join(HERE, filename)
    doc.save(out)
    doc.close()
    print(f"wrote {out}")


def policy() -> None:
    _write_pdf(
        "sample_policy.pdf",
        "BlueShield Select PPO - Summary of Benefits (SAMPLE / FICTIONAL)",
        [
            "Policyholder: Jordan Rivera",
            "Member ID: SAMPLE-XZ-4417  (fictional)",
            "Group: EVERGREEN-TECH-01",
            "Plan type: PPO   Plan year: 2026",
            "",
            "IN-NETWORK COST SHARING",
            "  Individual deductible: $1,500",
            "  Family deductible: $3,000",
            "  Individual out-of-pocket maximum: $6,000",
            "  Family out-of-pocket maximum: $12,000",
            "  Coinsurance after deductible: 20%",
            "",
            "COPAYS (IN-NETWORK, deductible waived)",
            "  Primary care visit (PCP): $30",
            "  Specialist visit: $60",
            "  Urgent care: $75",
            "  Emergency room (ER): $350 (waived if admitted)",
            "  Preventive care / annual physical: $0 (covered 100%)",
            "",
            "PRESCRIPTION DRUGS",
            "  Generic (Tier 1): $15",
            "  Preferred brand (Tier 2): $45",
            "  Rx deductible: none",
            "",
            "OUT-OF-NETWORK",
            "  Individual deductible: $3,000",
            "  Coinsurance after deductible: 40%",
            "",
            "NOTES",
            "  Preventive screenings covered at 100% in-network under ACA.",
            "  Specialist visits do not require a referral on this PPO.",
        ],
    )


def bill_clean() -> None:
    _write_pdf(
        "sample_bill_clean.pdf",
        "SAMPLE MEDICAL CENTER - Statement (SAMPLE / FICTIONAL)",
        [
            "Patient: Jordan Rivera        Account: SAMPLE-1001",
            "Date of service: 2026-05-12   Provider: In-Network Specialist",
            "",
            "  Code    Description                         Charge",
            "  99213   Specialist office visit, level 3    $220.00",
            "",
            "  Plan discount (in-network adjustment)      -$160.00",
            "  Specialist copay (per plan)                 $60.00",
            "",
            "  Patient responsibility:                     $60.00",
            "",
            "This statement matches the plan: $60 specialist copay, deductible waived.",
        ],
    )


def bill_overcharged() -> None:
    _write_pdf(
        "sample_bill_overcharged.pdf",
        "SAMPLE MEDICAL CENTER - Statement (SAMPLE / FICTIONAL)",
        [
            "Patient: Jordan Rivera        Account: SAMPLE-2002",
            "Date of service: 2026-06-03   Provider: In-Network ER",
            "",
            "  Code    Description                          Charge",
            "  99284   Emergency department visit            $1,850.00",
            "  99284   Emergency department visit            $1,850.00   <-- duplicate",
            "  80053   Comprehensive metabolic panel (lab)     $120.00",
            "  36415   Routine venipuncture (blood draw)        $45.00",
            "  99385   Preventive annual physical               $260.00   <-- covered 100% in-network",
            "",
            "  ER copay billed:                               $500.00   <-- plan says $350",
            "",
            "  Billed patient responsibility:               $4,120.00",
            "",
            "PLANTED ERRORS (for the checker to find):",
            "  1. Emergency department visit billed twice (duplicate 99284).",
            "  2. Preventive annual physical (99385) billed at $260; plan covers it 100%.",
            "  3. ER copay billed at $500 but the plan's ER copay is $350.",
        ],
    )


if __name__ == "__main__":
    policy()
    bill_clean()
    bill_overcharged()
    print("done")
