# Nucleus Phone — Onboarding Guide

Nucleus Phone is Joruva's outbound sales dialer. It runs in your browser — no app to install, no phone hardware needed. You search HubSpot contacts, click Call, and it connects you through Twilio with caller ID **(602) 600-0188**. All calls are recorded and transcribed automatically via Fireflies.

## What You Need

- **Chrome or Edge** (desktop or laptop — Safari has audio issues)
- **A headset** (strongly recommended — laptop speakers cause echo)
- **Microphone permission** (browser will ask on first use)
- A **@joruva.com** Microsoft account (Tom will add you to the system)

## Getting Started

### 1. Open the App

Go to **https://nucleus-phone.onrender.com**

### 2. Log In

- Click **Sign in with Microsoft**
- Sign in with your @joruva.com Microsoft account
- You'll be redirected back to the app automatically

### 3. Wait for "Ready"

The top bar shows your connection status:

| Status | Meaning |
|--------|---------|
| **Initializing** | Connecting to phone system — wait a few seconds |
| **Ready** (green) | You're good to go — you can make calls |
| **Error** (red) | Something went wrong — try refreshing the page |

If it stays on "Initializing" for more than 10 seconds, refresh the page. If "Error" persists, try logging out and back in.

## Making a Call

### 1. Find Your Contact

The main screen shows HubSpot contacts. Use the search bar to find someone by name, company, or email. Only contacts with phone numbers can be called.

### 2. Start the Call

Click a contact to see their details, then click **Call**. Here's what happens:

1. Your status changes to **Connecting**
2. You join a conference (you'll hear silence briefly)
3. The system dials the lead's phone — you'll hear it ringing
4. When they answer, you're connected — start talking

The lead sees **(602) 600-0188** as the caller ID.

### 3. During the Call

- **Mute** — Click the mute button if you need to (they can't hear you, you can still hear them)
- **Keypad** — Use the dialpad button if you need to press digits (phone trees, extensions)
- **Keep the tab open** — Closing or navigating away will drop the call

### 4. End the Call

Click **End Call** when you're done (or the lead hangs up — either way works).

### 5. Fill In the Disposition

After every call, you'll see the disposition screen. This takes 15 seconds and it matters — it feeds HubSpot and Slack alerts.

**Disposition** (required — pick the one that best fits):
- **Connected** — You spoke with the contact
- **Voicemail** — Left a voicemail
- **No Answer** — No pickup, no voicemail
- **Callback Requested** — They asked you to call back
- **Gatekeeper** — Got blocked by a gatekeeper
- **Wrong Number** — Not the right person
- **Not Interested** — They explicitly declined

**Qualification** (if you connected):
- **Hot** — Ready to buy, wants a quote, scheduling a demo
- **Warm** — Interested, wants more info, follow-up needed
- **Cold** — Polite but not interested right now

**Notes** — Brief summary of what was discussed. Doesn't need to be long — the call recording will have the full conversation. Focus on action items and key takeaways.

**Products Discussed** — Check any products that came up.

Click **Save** and you're back to the contacts screen, ready for the next call.

## Call History

Click **History** in the nav bar. By default you see your own calls. Use the dropdown to switch to "All callers" if you want to see what the team has been working.

Expand any call to see notes, qualification, products discussed, and a link to the recording.

## What Happens Automatically

You don't need to worry about any of this — it just works:

- **Recording** — Every call is recorded from the moment the conference starts
- **Fireflies** — Recordings are uploaded to Fireflies for transcription (takes a few minutes after the call)
- **HubSpot** — When you save a disposition, a note is added to the contact's timeline in HubSpot with the call details
- **Slack** — Hot and warm leads trigger an alert in Slack so the team sees it immediately

## Troubleshooting

**"Error" status after login**
- Refresh the page
- Make sure you're using Chrome or Edge (not Safari)
- Try logging out and back in

**Can't hear anything / they can't hear me**
- Check that your browser has microphone permission (look for the mic icon in the address bar)
- Make sure your headset is selected as the audio device in your OS settings
- Try refreshing the page

**Call drops immediately**
- Don't close or navigate away from the tab during a call
- Check your internet connection
- Refresh and try again

**Contact has no "Call" button**
- They don't have a phone number in HubSpot. The number needs to be in E.164 format (e.g., +16025551234).

**"Device not ready" error when clicking Call**
- Wait for the green "Ready" status before calling
- If it's stuck on Initializing, refresh the page

## For Admins (Tom)

### Active Calls

The **Active Calls** tab (admin-only) shows all calls currently in progress. You can:

- **Join Silent** — Listen in without being heard (coaching mode)
- **Join Call** — Join as a full participant (3-way call)

### Shadow Join Steps

1. Open the app on a second device (or second browser tab)
2. Log in as **tom**
3. Go to **Active Calls**
4. When someone is on a call, click **Join Silent** to listen or **Join Call** to speak

Both you and the caller need to have the app open with "Ready" status for this to work.
