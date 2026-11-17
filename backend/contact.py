"""Contact form: sends the visitor's message to the site owner by email.

Credentials live only in environment variables (never in code):
  GMAIL_USER          the Gmail address that sends the email
  GMAIL_APP_PASSWORD  a Google App Password for that address
  CONTACT_TO          optional, where messages go (defaults to GMAIL_USER)
"""
from __future__ import annotations

import os
import re
import smtplib
from email.message import EmailMessage

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ContactError(Exception):
    pass


def send_message(name: str, email: str, subject: str, message: str) -> None:
    name, email, subject, message = (s.strip() for s in (name or "", email or "", subject or "", message or ""))
    if not name or not message:
        raise ContactError("Please add your name and a message.")
    if not EMAIL_RE.match(email):
        raise ContactError("Please enter a valid email address.")
    if len(message) > 5000:
        raise ContactError("Your message is too long.")

    user = (os.getenv("GMAIL_USER") or "").strip().strip('"').strip("'")
    password = (os.getenv("GMAIL_APP_PASSWORD") or "").replace(" ", "").strip().strip('"').strip("'")
    if not user or not password:
        raise ContactError("The contact form is not set up yet. Please try again later.")
    to = (os.getenv("CONTACT_TO") or "").strip() or user

    msg = EmailMessage()
    msg["Subject"] = f"[Datagrove] {subject or 'New message'} — from {name}"
    msg["From"] = f"Datagrove Contact <{user}>"
    msg["To"] = to
    msg["Reply-To"] = email
    msg.set_content(f"Name: {name}\nEmail: {email}\nSubject: {subject or '-'}\n\n{message}\n")

    errors = []
    for mode in ("ssl", "starttls"):
        try:
            if mode == "ssl":
                with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
                    smtp.login(user, password)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP("smtp.gmail.com", 587, timeout=20) as smtp:
                    smtp.ehlo()
                    smtp.starttls()
                    smtp.ehlo()
                    smtp.login(user, password)
                    smtp.send_message(msg)
            return
        except smtplib.SMTPAuthenticationError as exc:
            print(f"[contact] {mode}: authentication failed ({exc.smtp_code})", flush=True)
            raise ContactError("We could not send your message right now. Please try again in a moment.") from exc
        except Exception as exc:
            errors.append(f"{mode}: {type(exc).__name__}: {str(exc)[:200]}")
    print("[contact] send failed: " + " | ".join(errors), flush=True)
    raise ContactError("We could not send your message right now. Please try again in a moment.")
