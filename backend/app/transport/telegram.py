"""Telegram Bot API transport: one channel message per blob.

Uses the cloud Bot API, where a bot can upload 50 MB but only download
20 MB, so 20 MB is the effective blob ceiling.

The bot must be a channel admin with: post messages, delete messages,
and edit messages (needed to pin the database snapshot).
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from collections import defaultdict

import httpx

from .base import BlobRef, Transport, Wait, report_wait

SNAPSHOT_CAPTION = "tgdrive-snapshot"
MAX_ATTEMPTS = 6
DELETE_BATCH = 100  # the most deleteMessages accepts in one call

log = logging.getLogger("tgdrive.telegram")


class TelegramError(Exception):
    pass


class TelegramTransport(Transport):
    max_blob_size = 20 * 1000 * 1000

    def __init__(self, token: str, chat_id: str, api_base: str = "https://api.telegram.org"):
        self.token = token
        self.chat_id = chat_id
        self.api_base = api_base.rstrip("/")
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0))

    async def close(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, data: dict | None = None, files: dict | None = None) -> dict:
        url = f"{self.api_base}/bot{self.token}/{method}"
        delay = 1.0
        for attempt in range(MAX_ATTEMPTS):
            last = attempt == MAX_ATTEMPTS - 1
            try:
                r = await self._http.post(url, data=data, files=files)
            except httpx.TransportError as e:
                if last:
                    raise TelegramError(f"{method}: {e!r}") from e
                report_wait(Wait("unreachable", delay, attempt + 1, MAX_ATTEMPTS))
                await asyncio.sleep(delay)
                delay *= 2
                continue
            try:
                body = r.json()
            except ValueError:
                body = {}
            if body.get("ok"):
                return body["result"]
            if r.status_code == 429 and not last:
                wait = body.get("parameters", {}).get("retry_after", delay) + 0.5
                report_wait(Wait("rate_limited", wait, attempt + 1, MAX_ATTEMPTS))
                await asyncio.sleep(wait)
                continue
            if r.status_code >= 500 and not last:
                report_wait(Wait("server_error", delay, attempt + 1, MAX_ATTEMPTS))
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise TelegramError(f"{method}: {r.status_code} {body.get('description', r.text[:200])}")
        raise TelegramError(f"{method}: gave up")

    async def _send(self, data: bytes, caption: str | None = None) -> dict:
        fields = {
            "chat_id": self.chat_id,
            "disable_notification": "true",
            "disable_content_type_detection": "true",
        }
        if caption:
            fields["caption"] = caption
        # Random name: nothing about the real file reaches Telegram.
        name = secrets.token_hex(16) + ".bin"
        return await self._call(
            "sendDocument", data=fields,
            files={"document": (name, data, "application/octet-stream")},
        )

    async def _download(self, file_id: str) -> bytes:
        info = await self._call("getFile", data={"file_id": file_id})
        url = f"{self.api_base}/file/bot{self.token}/{info['file_path']}"
        delay = 1.0
        for attempt in range(MAX_ATTEMPTS):
            try:
                r = await self._http.get(url)
                if r.status_code == 200:
                    return r.content
                err = f"{r.status_code}"
            except httpx.TransportError as e:
                err = repr(e)
            if attempt < MAX_ATTEMPTS - 1:
                await asyncio.sleep(delay)
                delay *= 2
        raise TelegramError(f"download failed: {err}")

    async def _file_id_from_message(self, ref: BlobRef) -> str:
        # file_ids belong to the bot that received them. If the bot was
        # replaced, forwarding the original message yields a fresh one.
        msg = await self._call("forwardMessage", data={
            "chat_id": self.chat_id,
            "from_chat_id": ref.chat_id,
            "message_id": ref.message_id,
            "disable_notification": "true",
        })
        await self._call("deleteMessage", data={"chat_id": self.chat_id, "message_id": msg["message_id"]})
        return msg["document"]["file_id"]

    async def put(self, data: bytes) -> BlobRef:
        msg = await self._send(data)
        return BlobRef(str(msg["chat"]["id"]), msg["message_id"], msg["document"]["file_id"])

    async def get(self, ref: BlobRef) -> bytes:
        try:
            return await self._download(ref.file_id)
        except TelegramError:
            return await self._download(await self._file_id_from_message(ref))

    async def delete(self, ref: BlobRef) -> None:
        await self._call("deleteMessage", data={"chat_id": ref.chat_id, "message_id": ref.message_id})

    async def delete_many(self, refs: list[BlobRef]) -> None:
        """One call per 100 messages instead of one per message. Telegram skips
        messages that are already gone."""
        by_chat: dict[str, list[int]] = defaultdict(list)
        for ref in refs:
            by_chat[ref.chat_id].append(ref.message_id)
        for chat_id, ids in by_chat.items():
            for i in range(0, len(ids), DELETE_BATCH):
                batch = ids[i:i + DELETE_BATCH]
                try:
                    await self._call("deleteMessages", data={"chat_id": chat_id, "message_ids": json.dumps(batch)})
                except TelegramError:
                    log.warning("could not delete %d message(s) from %s", len(batch), chat_id, exc_info=True)

    async def _pinned_snapshot(self) -> dict | None:
        chat = await self._call("getChat", data={"chat_id": self.chat_id})
        msg = chat.get("pinned_message")
        if msg and msg.get("caption") == SNAPSHOT_CAPTION and "document" in msg:
            return msg
        return None

    async def put_snapshot(self, data: bytes) -> None:
        old = await self._pinned_snapshot()
        msg = await self._send(data, caption=SNAPSHOT_CAPTION)
        await self._call("pinChatMessage", data={
            "chat_id": self.chat_id,
            "message_id": msg["message_id"],
            "disable_notification": "true",
        })
        if old:
            try:
                await self._call("deleteMessage", data={"chat_id": self.chat_id, "message_id": old["message_id"]})
            except TelegramError:
                pass  # the new snapshot is pinned; a stale one left behind is harmless

    async def get_snapshot(self) -> bytes | None:
        msg = await self._pinned_snapshot()
        if not msg:
            return None
        return await self._download(msg["document"]["file_id"])
