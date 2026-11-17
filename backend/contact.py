"""Contact form: sends the visitor's message to the site owner by email.

Credentials live only in environment variables (never in code).

Option A (recommended on Vercel): Resend HTTP email API
  RESEND_API_KEY      API key from resend.com
  CONTACT_TO          the email address that receives messages
Option B: Gmail SMTP (works where outbound SMTP is allowed)
  GMAIL_USER          the Gmail address that sends the email
  GMAIL_APP_PASSWORD  a Google App Password for that address
"""
from __future__ import annotations

import os
import re
import smtplib
import socket
import ssl

import httpx
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

    resend_key = (os.getenv("RESEND_API_KEY") or "").strip()
    to_addr = (os.getenv("CONTACT_TO") or os.getenv("GMAIL_USER") or "").strip()
    if resend_key and to_addr:
        _send_resend(resend_key, to_addr, name, email, subject, message)
        return

    user = (os.getenv("GMAIL_USER") or "").strip().strip('"').strip("'")
    password = "".join((os.getenv("GMAIL_APP_PASSWORD") or "").split()).strip('"').strip("'")
    user = "".join(user.split())
    if not user or not password:
        raise ContactError("The contact form is not set up yet. Please try again later.")
    to = (os.getenv("CONTACT_TO") or "").strip() or user

    msg = EmailMessage()
    msg["Subject"] = f"[Datagrove] {subject or 'New message'} — from {name}"
    msg["From"] = f"Datagrove Contact <{user}>"
    msg["To"] = to
    msg["Reply-To"] = email
    msg.set_content(f"Name: {name}\nEmail: {email}\nSubject: {subject or '-'}\n\n{message}\n")

    # Shape check only (never the values): helps spot copy-paste mistakes
    print(
        f"[contact] config: user_len={len(user)} user_has_at={'@' in user} "
        f"user_ascii={user.isascii()} pass_len={len(password)} pass_letters_only={password.isalpha()} "
        f"pass_ascii={password.isascii()}",
        flush=True,
    )
    errors = []
    original_getaddrinfo = socket.getaddrinfo

    def ipv4_first(*args, **kwargs):  # some serverless networks have no IPv6 route
        results = original_getaddrinfo(*args, **kwargs)
        v4 = [r for r in results if r[0] == socket.AF_INET]
        return v4 or results

    socket.getaddrinfo = ipv4_first
    try:
        for mode, port in (("ssl", 465), ("starttls", 587)):
            stage = "connect"
            try:
                ctx = ssl.create_default_context()
                if mode == "ssl":
                    smtp = smtplib.SMTP_SSL("smtp.gmail.com", port, timeout=20, context=ctx)
                else:
                    smtp = smtplib.SMTP("smtp.gmail.com", port, timeout=20)
                with smtp:
                    stage = "hello"
                    smtp.ehlo()
                    if mode == "starttls":
                        stage = "starttls"
                        smtp.starttls(context=ctx)
                        smtp.ehlo()
                    stage = "login"
                    smtp.login(user, password)
                    stage = "send"
                    smtp.send_message(msg)
                return
            except smtplib.SMTPAuthenticationError as exc:
                print(f"[contact] {mode}: Gmail rejected the login ({exc.smtp_code}). Check GMAIL_USER and GMAIL_APP_PASSWORD.", flush=True)
                raise ContactError("We could not send your message right now. Please try again in a moment.") from exc
            except Exception as exc:
                errors.append(f"{mode}@{stage}: {type(exc).__name__}: {str(exc)[:200]}")
    finally:
        socket.getaddrinfo = original_getaddrinfo
    print("[contact] send failed: " + " | ".join(errors), flush=True)
    raise ContactError("We could not send your message right now. Please try again in a moment.")

def _send_resend(key: str, to_addr: str, name: str, email: str, subject: str, message: str) -> None:
    sender = (os.getenv("CONTACT_FROM") or "Datagrove Contact <onboarding@resend.dev>").strip()
    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "from": sender,
                "to": [to_addr],
                "reply_to": email,
                "subject": f"[Datagrove] {subject or 'New message'} — from {name}",
                "text": f"Name: {name}\nEmail: {email}\nSubject: {subject or '-'}\n\n{message}\n",
            },
            timeout=20,
        )
    except Exception as exc:
        print(f"[contact] resend: {type(exc).__name__}", flush=True)
        raise ContactError("We could not send your message right now. Please try again in a moment.") from exc
    if resp.status_code >= 300:
        print(f"[contact] resend: HTTP {resp.status_code} {resp.text[:200]}", flush=True)
        raise ContactError("We could not send your message right now. Please try again in a moment.")
