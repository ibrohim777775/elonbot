import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSendingTime, parseSendingWindow, sendingDeadline, validSendingWindow } from "../schedule";
import { migrate } from "../migrate";
import { announcement, seed, testDatabase } from "./helpers";
import { one } from "../db";

test("daily windows include opening time, exclude closing time and use Tashkent independently of host timezone", () => {
  const window = parseSendingWindow("7-22")!;
  const next = (time: string) => nextSendingTime(new Date(time), window).toISOString();
  assert.equal(next("2030-06-01T01:59:59.999Z"), "2030-06-01T02:00:00.000Z");
  assert.equal(next("2030-06-01T02:00:00Z"), "2030-06-01T02:00:00.000Z");
  assert.equal(next("2030-06-01T16:59:59.999Z"), "2030-06-01T16:59:59.999Z");
  assert.equal(next("2030-06-01T17:00:00Z"), "2030-06-02T02:00:00.000Z");
  assert.equal(next("2030-12-31T18:30:22.222Z"), "2031-01-01T02:00:00.000Z");
  assert.equal(sendingDeadline(new Date("2030-06-01T02:00:00Z"), window), Date.parse("2030-06-01T17:00:00Z"));
  assert.equal(sendingDeadline(new Date("2030-06-01T17:00:00Z"), window), Date.parse("2030-06-01T17:00:00Z"));
});

test("custom minute precision, midnight windows and all-day schedules", () => {
  const night = parseSendingWindow("22:00—07:30")!;
  for (const value of ["2030-06-01T17:00:00Z", "2030-06-01T19:00:00Z", "2030-06-02T02:29:59Z"]) {
    assert.equal(nextSendingTime(new Date(value), night).getTime(), Date.parse(value));
    assert.equal(sendingDeadline(new Date(value), night), Date.parse("2030-06-02T02:30:00Z"));
  }
  assert.equal(nextSendingTime(new Date("2030-06-02T02:30:00Z"), night).toISOString(), "2030-06-02T17:00:00.000Z");
  assert.equal(nextSendingTime(new Date("2030-06-01T02:30:00Z"), parseSendingWindow("07:31-21:45")!).toISOString(), "2030-06-01T02:31:00.000Z");
  const midnight = parseSendingWindow("7-24:00")!;
  assert.equal(sendingDeadline(new Date("2030-06-01T18:59:59Z"), midnight), Date.parse("2030-06-01T19:00:00Z"));
  assert.equal(nextSendingTime(new Date("2030-06-01T19:00:00Z"), midnight).toISOString(), "2030-06-02T02:00:00.000Z");
  for (const window of [{}, { send_start_minute: null, send_end_minute: null }, parseSendingWindow("00:00-24:00")!]) {
    const at = new Date("2030-06-01T17:00:00Z");
    assert.equal(nextSendingTime(at, window), at); assert.equal(sendingDeadline(at, window), undefined);
  }
  for (const invalid of ["24-7", "7-25", "07:99-22:00", "7-7", "12:30-12:30", "00:00-24:01", "7:1-22", "7-22 rubbish", "-1-22", ""]) assert.equal(parseSendingWindow(invalid), undefined, invalid);
  assert.equal(validSendingWindow({ send_start_minute: 420 }), false);
});

test("sending-window migration preserves existing schedules and enforces paired valid values", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    const before = await one(database, "SELECT next_run_at FROM announcements WHERE id=$1", [id]);
    await database.query("ALTER TABLE announcements DROP COLUMN send_start_minute, DROP COLUMN send_end_minute");
    await migrate(database); await migrate(database);
    const row = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(row.send_start_minute, null); assert.equal(row.send_end_minute, null);
    assert.deepEqual(row.next_run_at, before.next_run_at); assert.equal(row.status, "active");
    await assert.rejects(database.query("UPDATE announcements SET send_start_minute=420 WHERE id=$1", [id]));
    await assert.rejects(database.query("UPDATE announcements SET send_start_minute=420,send_end_minute=420 WHERE id=$1", [id]));
    await database.query("UPDATE announcements SET send_start_minute=420,send_end_minute=1320 WHERE id=$1", [id]);
    await migrate(database);
    assert.equal((await one(database, "SELECT send_start_minute FROM announcements WHERE id=$1", [id])).send_start_minute, 420);
  } finally { await pg.close(); }
});
