# Deposit campaign and owner email alerts

Enable the campaign on Render with `DEPOSIT_BONUS_MODE=after-six-rounds`. The default is `off`; existing requests created before activation receive no retroactive bonus. Set `PAYMENT_EMAIL_ALERTS_ENABLED=true` and keep the existing SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM configured for Nodemailer. Do not put these credentials in Vercel or chat.

## Customer terms

- Verified deposits from 100 through 999 ETB receive 10%. Deposits strictly above 999 ETB receive 15%, including 999.01 ETB. Bonus amounts round down to the nearest cent.
- Every eligible deposit receives a bonus; owner and agent deposits used for operational funding are excluded.
- The bonus becomes playable only when the deposit is approved. Its amount is held from withdrawals until six distinct completed cash rounds in Azmera Flight or Azmera Jet, started after approval. Two slots in one round count as one round. Practice rounds, canceled bets and interrupted/refunded rounds do not count. Paid or lost bets count after the round finishes.
- Each deposit has its own progress starting at its approval. A completed round can advance multiple bonuses for which it qualifies. Earlier play does not satisfy a later deposit's requirement. There is no additional stake multiple or bonus expiry.
- The wallet shows total playable balance and withdrawable balance. Withdrawable funds equal available cash minus the total still-locked bonus amounts, with a minimum of zero. If losses leave less than the held amount, all remaining available funds stay held until the six-round requirement is met. Completing rounds does not restore money already lost. Winnings above the held amount can be withdrawn under normal payment limits.
- Rejected or canceled deposits earn no bonus. A duplicate approval cannot grant a second bonus.

## Funding and administration

The rate and amount are stored when the deposit request is created. Disabling the campaign does not remove bonuses already promised on existing requests. Approval transfers the bonus from available house capital into the customer's cash wallet in the same database transaction as the principal. Money reserved for open game bets is not used. If available house capital is insufficient, the approval fails without crediting either portion; fund the house and retry approval. No bonus money is manufactured.

Check receiving accounts, maintain sufficient house capital and deploy both frontend and backend before posting the campaign. The new schema tables are deposit_bonuses and payment_alerts. Keep ordinary database backups; never manually edit wallet balances to grant bonuses.

## Owner notifications

Email goes to asfawfanual2003@gmail.com when deposit proof is submitted or a withdrawal is successfully requested. Draft deposits do not trigger alerts. Each request queues one event transactionally. A background worker checks every two seconds, then sends outside the payment transaction. SMTP delays do not block deposits, withdrawals or game settlement. Email receipt timing depends on the provider; it is not guaranteed instantaneous.

Notifications include request ID, amount, method, user name/ID, submission time and the app link. They are not proof of a bank transfer. Check the current request status in Payment review before acting. No SMS service or phone messaging is configured.

Events persist across restarts. Failed attempts retry with exponential backoff, up to ten attempts. Failed events remain in payment_alerts for diagnosis. When credentials are absent, events remain pending; enabling SMTP later sends the backlog with the original submission timestamps. Delivery is at least once: a crash after SMTP acceptance but before recording success can produce a duplicate email with the same reference. Workers claim events with a two-minute lease to avoid concurrent sends.

See [Feedback email setup](FEEDBACK-EMAIL.md) for Render SMTP restrictions and credentials. Tests use synthetic funds and mocked/local mail transports, never actual customer payments or owner email.

## Poster

The launch poster is in output/promotions. Generated using the built-in image tool, with a premium emerald/navy/gold aircraft launch design, Azmera Flight and Azmera Jet, exact 10%/15% deposit tiers, Amharic launch headline, bot/channel links, six-round unlock condition and 18+ footer. Publish only after the campaign is enabled and the games are accepting cash bets. No broadcast is sent by this implementation.
