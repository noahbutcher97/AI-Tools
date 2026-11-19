import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:os";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";

const TAG = /^[a-f0-9]{64}$/;
export function validExit(event) {
  if (!exactKeys(event, ["code", "signal"])) return false;
  if (event.signal === null) return Number.isInteger(event.code) && event.code >= -2147483648 && event.code <= 4294967295;
  return event.code === null && typeof event.signal === "string" && Object.hasOwn(constants.signals, event.signal);
}

export function validJobFrame(frame) {
  return exactKeys(frame, ["v", "op", "id", "nonce", "event", "mac"]) && frame.v === 1 &&
    matches(UUID, frame.id) && matches(/^[a-f0-9]{32}$/, frame.nonce) && matches(TAG, frame.mac) &&
    (((frame.op === "claim" || frame.op === "start_failed") && frame.event === null) ||
      (["claim_run","available_run"].includes(frame.op) && exactKeys(frame.event, ["session"]) && matches(UUID, frame.event.session)) ||
      (frame.op === "complete" && validExit(frame.event)));
}

export function jobMac(key, frame, direction) {
  const fields = ["relay-job-v1", direction, frame.op, frame.id, frame.nonce,
    frame.event?.code ?? null, frame.event?.signal ?? null];
  if (["claim_run","available_run"].includes(frame.op)) fields.push(frame.event.session);
  return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}

export function sameMac(actual, expected) {
  return matches(TAG, actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function prepareJobRequest(grant, op, event) {
  if (!matches(TAG, grant?.capability)) throw new Error("invalid job grant");
  const key = Buffer.from(digest(grant.capability), "hex");
  const frame = { v: 1, op, id: grant.id, nonce: randomBytes(16).toString("hex"), event, mac: "0".repeat(64) };
  if (!validJobFrame(frame)) throw new Error("invalid job request");
  frame.mac = jobMac(key, frame, "request");
  return { frame, accepts: reply => exactKeys(reply, ["ack"]) && sameMac(reply.ack, jobMac(key, frame, "ack")) };
}
