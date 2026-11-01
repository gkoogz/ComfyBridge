"""Queue positions shared by the worker and an upgrading Windows tray."""
import json
import os
from pathlib import Path
import sqlite3
import uuid

LIVE_JOBS = "status IN ('pending','submitting','running','cancelling')"


def prepare(db):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='assign_queue_run'").fetchone():
        return
    with db:
        db.execute('BEGIN IMMEDIATE')
        if 'queue_run' not in {row[1] for row in db.execute('PRAGMA table_info(jobs)')}:
            db.execute('ALTER TABLE jobs ADD COLUMN queue_run TEXT')
            # Old databases have no idle timestamps. Preserve completed members
            # of batches still outstanding when upgrading a running queue.
            db.execute(f"UPDATE jobs SET queue_run=? WHERE batch IN (SELECT batch FROM jobs WHERE {LIVE_JOBS})",
                       (str(uuid.uuid4()),))
        db.execute('CREATE INDEX IF NOT EXISTS jobs_queue_run ON jobs(queue_run)')
        db.execute(f"""
            CREATE TRIGGER IF NOT EXISTS assign_queue_run AFTER INSERT ON jobs
            WHEN NEW.queue_run IS NULL BEGIN
                UPDATE jobs SET queue_run=COALESCE(
                    (SELECT queue_run FROM jobs WHERE {LIVE_JOBS}
                     AND rowid!=NEW.rowid AND queue_run IS NOT NULL LIMIT 1),
                    NEW.batch) WHERE rowid=NEW.rowid;
            END""")


def positions(db):
    # The rank includes finished jobs even when a phone asks for one batch.
    # Cancelled jobs do not occupy a place. Return only still-active entries.
    return {job_id: (position, total) for job_id, position, total in db.execute(f"""
        SELECT id, position, total FROM (
            SELECT id, status, row_number() OVER (ORDER BY rowid) AS position,
                   count(*) OVER () AS total
            FROM jobs WHERE status!='cancelled' AND queue_run=(
                SELECT queue_run FROM jobs WHERE {LIVE_JOBS} LIMIT 1)
        ) WHERE {LIVE_JOBS}""")}


if __name__ == '__main__':
    # A beta 5 worker can finish its queue and continue accepting jobs normally.
    # The tray calls this only when that worker's outstanding jobs change.
    with sqlite3.connect(Path(os.environ['LOCALAPPDATA'])/'ComfyBridge/library.sqlite') as db:
        prepare(db)
        print(json.dumps(positions(db)))
