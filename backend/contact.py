"""Contact form: sends the visitor's message to the site owner by email.

Credentials live only in environment variables (never in code):
  GMAIL_USER          the Gmail address that sends and receives messages
  GMAIL_APP_PASSWORD  a Google App Password for that address
  CONTACT_TO          optional, where messages go (defaults to GMAIL_USER)

If Gmail SMTP is unavailable, the message is delivered through FormSubmit
(form-to-email over HTTPS) to the same address.
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

    user = (os.getenv("GMAIL_USER") or "").strip().strip('"').strip("'")
    password = "".join((os.getenv("GMAIL_APP_PASSWORD") or "").split()).strip('"').strip("'")
    user = "".join(user.split())
    to = (os.getenv("CONTACT_TO") or "").strip() or user
    if not to:
        raise ContactError("The contact form is not set up yet. Please try again later.")
    if not user or not password:
        _send_formsubmit(to, name, email, subject, message)
        return

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
                    smtp.user, smtp.password = user, password
                    smtp.auth("LOGIN", smtp.auth_login, initial_response_ok=False)
                    stage = "send"
                    smtp.send_message(msg)
                return
            except smtplib.SMTPAuthenticationError as exc:
                print(f"[contact] {mode}: Gmail rejected the login ({exc.smtp_code}). Check GMAIL_USER and GMAIL_APP_PASSWORD.", flush=True)
                errors.append(f"{mode}@login: rejected {exc.smtp_code}")
                break
            except Exception as exc:
                errors.append(f"{mode}@{stage}: {type(exc).__name__}: {str(exc)[:200]}")
    finally:
        socket.getaddrinfo = original_getaddrinfo
    print("[contact] gmail failed: " + " | ".join(errors), flush=True)
    # Backup: FormSubmit (form-to-email over HTTPS). The address comes from env vars, never from code.
    _send_formsubmit(to, name, email, subject, message)

def _send_formsubmit(to_addr: str, name: str, email: str, subject: str, message: str) -> None:
    site = os.getenv("SITE_URL", "https://datagrove-ai.vercel.app")
    try:
        resp = httpx.post(
            f"https://formsubmit.co/ajax/{to_addr.strip()}",
            headers={"Accept": "application/json", "Origin": site, "Referer": site + "/contact"},
            json={
                "name": name,
                "email": email,
                "_replyto": email,
                "_subject": f"[Datagrove] {subject or 'New message'} — from {name}",
                "_template": "table",
                "_captcha": "false",
                "message": message,
            },
            timeout=20,
        )
        body = resp.text[:300]
    except Exception as exc:
        print(f"[contact] formsubmit: {type(exc).__name__}", flush=True)
        raise ContactError("We could not send your message right now. Please try again in a moment.") from exc
    # never log the address; only the service reply
    print(f"[contact] formsubmit: HTTP {resp.status_code} {body.replace(to_addr, '<owner>')}", flush=True)
    if resp.status_code >= 300 or '"success":"false"' in body.replace(" ", ""):
        raise ContactError("We could not send your message right now. Please try again in a moment.")
