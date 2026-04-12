/**
 * HEAL email service — sends billing dispute letters via Gmail SMTP
 * Requires: GMAIL_USER and GMAIL_APP_PASSWORD in .env
 *
 * Setup (one-time, 3 steps):
 *   1. Go to myaccount.google.com → Security → 2-Step Verification → enable it
 *   2. Go to myaccount.google.com → Security → App passwords → create one named "HEAL"
 *   3. Copy the 16-char password into GMAIL_APP_PASSWORD in heal-slack-bot/.env
 */

import nodemailer from 'nodemailer';

// ── ICS (calendar invite) generator ──────────────────────────────────────────

function generateICS({ name, university, phone, datetime, reason, insuranceName, insuranceNumber, conditions }) {
    const uniHealth = university ? `${university} Health Center` : 'Campus Health Center';
    const now       = new Date();

    // Use local floating time (no Z) so the event shows at the right hour in any timezone.
    // "20260415T090000" means 9 AM wherever the calendar app is opened.
    const fmtLocal = d => {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
               `T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    };
    // Stamp still uses UTC (standard requirement)
    const fmtUTC = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    let dtStart = new Date(datetime);  // datetime is now an ISO string from tryParseDateTime
    if (isNaN(dtStart.getTime())) dtStart = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dtEnd = new Date(dtStart.getTime() + 60 * 60 * 1000);

    const desc = [
        `Patient: ${name || 'N/A'}`,
        `Phone: ${phone || 'N/A'}`,
        `Insurance: ${insuranceName || 'N/A'}`,
        `Insurance #: ${insuranceNumber || 'N/A'}`,
        `Conditions: ${conditions || 'None'}`,
        `Reason: ${reason || 'N/A'}`,
    ].join('\\n');

    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//HEAL AI//Medical Appointment//EN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:heal-apt-${Date.now()}@healai`,
        `DTSTAMP:${fmtUTC(now)}`,
        `DTSTART:${fmtLocal(dtStart)}`,
        `DTEND:${fmtLocal(dtEnd)}`,
        `SUMMARY:Medical Appointment — ${uniHealth}`,
        `DESCRIPTION:${desc}`,
        `LOCATION:${uniHealth}`,
        'BEGIN:VALARM',
        'TRIGGER:-PT30M',
        'ACTION:DISPLAY',
        'DESCRIPTION:Appointment reminder — 30 minutes',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');
}

/**
 * Email a calendar invite (.ics) to the patient.
 */
export async function sendCalendarInvite({ to, ...apt }) {
    const uniHealth = apt.university ? `${apt.university} Health Center` : 'Campus Health Center';
    const ics       = generateICS(apt);

    const transport = createTransport();
    const subject   = `Medical Appointment — ${uniHealth} — ${apt.datetime || 'Time TBD'}`;

    await transport.sendMail({
        from:    `"HEAL AI" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        text:
            `Your appointment request at ${uniHealth} has been confirmed.\n\n` +
            `Patient: ${apt.name || 'N/A'}\n` +
            `Insurance: ${apt.insuranceName || 'N/A'}\n` +
            `Date/Time: ${apt.datetime || 'TBD'}\n` +
            `Reason: ${apt.reason || 'N/A'}\n\n` +
            `Open the attached .ics file to add this to your calendar.\n\n` +
            `— HEAL AI`,
        attachments: [
            {
                filename:    'appointment.ics',
                content:     ics,
                contentType: 'text/calendar; method=REQUEST',
            },
        ],
    });

    return { to, subject };
}

function createTransport() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD,
        },
    });
}

export function isEmailConfigured() {
    return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

/**
 * Send a formal billing dispute letter.
 *
 * @param {object} opts
 * @param {string} opts.to             Recipient email (billing dept or patient)
 * @param {string} opts.patientName
 * @param {string} opts.insuranceName
 * @param {string} opts.insuranceNumber
 * @param {string} opts.discrepancies  Plain-text findings from the bill analysis
 * @param {number} [opts.totalOvercharge]
 * @param {number} [opts.correctOwed]
 * @param {number} [opts.billedAmount]
 * @returns {{ subject: string, body: string, to: string }}
 */
export async function sendDisputeLetter({
    to,
    patientName,
    insuranceName,
    insuranceNumber,
    discrepancies,
    totalOvercharge,
    correctOwed,
    billedAmount,
}) {
    const subject = `Medical Billing Dispute — ${patientName || 'Patient'} — ${insuranceName || 'Insurance'} #${insuranceNumber || 'N/A'}`;

    const overchargeBlock = totalOvercharge > 0
        ? `\nTotal overcharge identified:   $${Number(totalOvercharge).toFixed(2)}` +
          (correctOwed != null ? `\nCorrect amount owed:           $${Number(correctOwed).toFixed(2)}` : '') +
          `\nAmount billed to patient:      $${Number(billedAmount || 0).toFixed(2)}\n`
        : '';

    const body = `Dear Billing Department,

I am writing to formally dispute charges on a recent medical bill for the following patient:

  Patient name:   ${patientName || 'N/A'}
  Insurance:      ${insuranceName || 'N/A'}
  Insurance ID:   ${insuranceNumber || 'N/A'}

After reviewing the bill against my insurance policy, the following discrepancies were identified:

${discrepancies}
${overchargeBlock}
I respectfully request that you review and correct the above discrepancies and issue an amended Explanation of Benefits (EOB) and corrected billing statement reflecting the accurate patient responsibility.

Please respond in writing within 30 days of receipt of this letter. If I do not receive a satisfactory response, I reserve the right to file a formal complaint with my state insurance commissioner and the appropriate regulatory authority.

Sincerely,
${patientName || 'Patient'}


---
This dispute letter was generated by HEAL AI (https://github.com/pranawwwww/HEAL_AI).
HEAL AI is not a licensed insurance adjuster or legal advisor. This letter is provided
as a starting point — please review before sending to a billing department.
`.trim();

    const transport = createTransport();
    await transport.sendMail({
        from: `"HEAL AI" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        text: body,
    });

    return { subject, body, to };
}

/**
 * Build a preview string for Slack (truncated, no full body).
 */
export function previewLetter({ to, patientName, insuranceName, insuranceNumber, discrepancies, totalOvercharge, correctOwed }) {
    const overchargeNote = totalOvercharge > 0
        ? `Overcharge: *$${Number(totalOvercharge).toFixed(2)}* → Correct amount: *$${Number(correctOwed || 0).toFixed(2)}*`
        : 'No overcharge amount on file.';

    const preview = discrepancies?.split('\n').slice(0, 5).join('\n') +
        (discrepancies?.split('\n').length > 5 ? '\n_(+ more)_' : '');

    return (
        `📧 *Draft Dispute Letter*\n\n` +
        `*To:* ${to}\n` +
        `*Subject:* Medical Billing Dispute — ${patientName || 'Patient'} — ${insuranceName || 'Insurance'} #${insuranceNumber || 'N/A'}\n\n` +
        `*Summary of findings:*\n${preview}\n\n` +
        `${overchargeNote}\n\n` +
        `Reply *send* to send this email, or *cancel* to abort.`
    );
}
