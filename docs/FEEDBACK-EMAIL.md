# Feedback email setup

The sidebar Feedback form sends signed-in users' messages to **asfawfanual2003@gmail.com** through Nodemailer. The destination is fixed on the server. Optional reply email becomes Reply-To; the verified SMTP sender remains From. Messages are plain text, limited to 5,000 characters and five submissions per account per hour. Credentials never reach the frontend.

Set these variables on **Render**, not Vercel:

```dotenv
SMTP_HOST=your-provider-smtp-host
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=your-verified-sender@example.com
```

Port 465 uses immediate TLS. Other ports require STARTTLS. Certificate validation remains enabled. Use a sender authorized by your mail provider. For Gmail, use smtp.gmail.com with port 465 and a Google app password where the account supports app passwords, not the normal account password. SMTP_FROM should match the sending Gmail account. Keep credentials in Render's secret environment settings.

Render Free blocks outbound SMTP ports 25, 465 and 587. Use a paid backend for conventional SMTP, or a mail provider's supported alternative submission port (for example 2525) after checking connectivity. Port 25 is blocked on all Render services. See [Render Free limits](https://render.com/docs/free) and [Nodemailer SMTP](https://nodemailer.com/smtp).

The application reports success only after the SMTP server accepts the destination; this does not guarantee inbox placement. Check spam and provider delivery logs. Without configured SMTP the form returns an explicit unavailable message, not false success.

Submissions are stored in `feedback_messages` with sending/sent/failed status. Repeating a request ID does not resend it. Delivery happens outside the monetary database transaction. A process crash after SMTP acceptance can leave a sending record: reconcile by its message ID with provider logs before manually resending. There is no automatic retry worker. Failed/unconfirmed delivery may be retried as a new submission, with possible duplication if the provider accepted the original before a connection failure. Retain these records according to your feedback/privacy retention policy.

The automated tests use Nodemailer's local stream transport. No real email is sent by tests. Production delivery still needs valid SMTP credentials and a deployed connectivity check.
