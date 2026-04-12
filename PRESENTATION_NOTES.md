# HEAL AI — Presentation Notes
Devlabs Hackathon 2026 · Thinkn + UcheNova Tracks

---

## The Core Message (say this in your head before you go up)

> "1 in 3 Americans get overbilled on medical bills. Nobody catches it. We built the thing that does — and it lives entirely inside Slack."

Everything you say should connect back to this.

---

## Slide-by-Slide Talking Points

### Slide 1 — Title
- Don't read the slide. Let it breathe.
- Say: *"HEAL AI is a healthcare financial advocate. It lives in Slack. You never open a new tab."*
- Pause. Move on.

---

### Slide 2 — The Problem
- Lead with the stat: *"1 in 3 medical bills contain errors. That's not a niche problem — that's your colleague, your roommate, you."*
- Point to the $0 stat: *"The average number of formal disputes filed by overcharged patients is zero. Not because they're not overcharged — because the process is designed to be impossible."*
- The $935B is the scale signal. Say it and move on — don't dwell.
- Close: *"The system is confusing on purpose. We make it simple."*

---

### Slide 3 — How It Works
- Walk through the four steps as the cards animate in.
- Keep it fast: *"Upload your policy. Upload your bill. AI flags every discrepancy. One command sends the dispute letter."*
- Then point to the tag at the bottom: *"And all of this — every single step — happens inside one Slack DM. No new app. No browser tab. No learning curve."*

---

### Slide 4 — Demo
**This is the most important slide. Slow down here.**

Before showing the demo, say:
> *"Let me show you what this actually looks like."*

Walk through the Slack conversation on screen:
1. *"User uploads their insurance PDF and says 'check my bill'."*
2. *"HEAL reads the policy — extracts the deductible, copay, out-of-pocket max — in seconds."*
3. *"Then it finds this: CPT code 99385. Preventive visit. The policy says $0 cost-sharing. The bill says $147. That's a billing error."*
4. *"User types 'yes'. Dispute letter goes to the billing department by email. Done."*

Closing line: *"From 'I got a bill' to 'dispute sent' — inside Slack, under two minutes."*

---

### Slide 5 — Two Tracks

#### Thinkn (left panel)
- *"We're using the Thinkn beliefs SDK to give HEAL persistent memory — not just in-session, but across restarts."*
- *"Every Slack user gets their own belief graph scoped to their user ID. HEAL remembers your policy, your conditions, your history."*
- *"When you come back a week later, HEAL already knows who you are. It doesn't ask you to re-explain your coverage. The agent gets smarter every conversation."*
- Key phrase: **"This isn't a cache. It's a queryable knowledge graph that survives a process restart."**

#### UcheNova (right panel)
- Lead with integration depth (50% of their score): *"From one Slack DM, HEAL touches four external systems — Gemini AI, email, OpenStreetMap for real hospital data, and Google Calendar for .ics invites."*
- *"PDF upload, AI analysis, email sent, calendar invite delivered. Full pipeline. Zero new tabs."*
- Pain point close: *"Employees and students get medical bills they can't decode. They don't have a billing consultant. They have Slack. Now Slack has HEAL."*

---

### Slide 6 — Closing
- Read the headline slowly: *"Healthcare advocacy for everyone."*
- Point to the pills: *"RAG over your actual policy document. Real hospital data from OpenStreetMap — not hallucinations. Persistent agent memory. Dispute letters. Calendar invites."*
- Close: *"The next time you get a medical bill, you'll know exactly what to do. And so will HEAL."*

---

## Live Demo Flow (if you have time to show the actual bot)

Run this sequence in a real Slack DM with `@healai`:

1. **Upload a policy PDF** — say what you're doing out loud
2. **Upload a sample bill** — "I'm uploading a bill that has a billing error baked in"
3. **Watch HEAL respond** — point out the discrepancy card, the dollar amount, the CPT code
4. **Type "yes"** — show the dispute letter confirmation
5. **Optional:** Ask "find hospitals near me" — show the OpenStreetMap results, mention it's real data not AI speculation

If something breaks: *"This is a live demo — the backend is running locally. The flow you saw on the previous slide is exactly what this produces."* Don't apologize. Move on.

---

## Key Phrases to Use

| Context | Say this |
|---------|----------|
| Opening | *"It lives entirely inside Slack."* |
| On the problem | *"The system is designed to be confusing."* |
| On the demo | *"From upload to dispute sent — under two minutes."* |
| On Thinkn | *"A queryable knowledge graph that survives a restart."* |
| On UcheNova | *"Four external systems. One Slack DM."* |
| Closing | *"Healthcare advocacy for everyone."* |

---

## What NOT to Say

- Don't say "we tried to" or "we attempted" — you built it, it works
- Don't apologize for technical jargon — lean into CPT codes, EOB, cost-sharing — it shows you understand the domain
- Don't over-explain the beliefs SDK internals (`before()`, `after()`) in the pitch — keep it conceptual; have the code ready for Q&A
- Don't mention implementation issues or bugs from development

---

## Likely Q&A

**"How is this different from just asking ChatGPT?"**
> *"ChatGPT doesn't know your specific policy. HEAL extracts your actual coverage details, cross-references them against your actual bill line by line, and takes action — sends the email. It's not a chatbot. It's an advocate."*

**"What if the policy PDF is complex?"**
> *"We use Google Gemini with a RAG pipeline — the policy is chunked, embedded, and retrieved semantically. It handles multi-page EOBs with dozens of coverage clauses."*

**"How does the beliefs SDK help specifically?"**
> *"Without it, every conversation starts from zero. With it, HEAL builds a per-user knowledge graph — your deductible, conditions, history — that persists across sessions and bot restarts. The clarity score goes up as HEAL learns more about you."*

**"Is this HIPAA compliant?"**
> *"This is a hackathon prototype. Production would require proper data handling — encrypted storage, no PII in logs. The architecture supports that path."*

---

## Timing Guide (3-minute pitch)

| Slide | Time |
|-------|------|
| Title | 15s |
| Problem | 30s |
| How it works | 30s |
| Demo | 60s ← most time here |
| Two tracks | 30s |
| Closing | 15s |
