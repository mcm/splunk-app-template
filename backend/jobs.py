"""Example scheduled jobs, and the KV store collection they maintain.

This is ordinary Python. The only two Splunk-specific things are `@scheduled` and
`collection()`, and both are *declarations*: the build imports this module, reads them, and
generates `inputs.conf`, `README/inputs.conf.spec` and `collections.conf` from what it finds.
There is no conf file to keep in sync, and no modular input protocol to implement.

To add a job: write a decorated function here (or in a new module) and add it to
`splunkApp.jobs` in package.json - the same shape as adding a page to `source.entry`.

Delete this file, and its entries in `splunkApp.jobs`, when you start your own app.
"""

import time

from pydantic import BaseModel

from splunkapp import collection, scheduled, search


class SourcetypeActivity(BaseModel):
    """Most recently observed throughput for one sourcetype."""

    sourcetype: str
    kilobytes: float
    observed_at: float


# Declaring the collection is what creates it - the build writes the matching
# `collections.conf` stanza, deriving each field's type from the annotations above.
#
# `lookup=True` would additionally generate a transforms.conf lookup so this were usable as
# `| lookup sourcetype_activity_lookup ...` in SPL. It is left off here because nothing
# searches this collection, and because shipping transforms.conf brings an extra App Inspect
# check into scope for apps that bundle compiled dependencies.
ACTIVITY = collection(SourcetypeActivity, name="sourcetype_activity")


@scheduled(seconds=300, index="main", sourcetype="my_splunk_app:activity")
def collect(splunk, state, log):
    """Record how much each sourcetype has indexed recently."""
    rows = search(
        splunk,
        "search index=_internal source=*metrics.log group=per_sourcetype_thruput "
        "| stats sum(kb) as kb by series",
        earliest_time="-5m",
        latest_time="now",
    )
    log.info("observed %d sourcetype(s)", len(rows))

    observed_at = time.time()
    store = ACTIVITY.bind(splunk)
    events = []

    for row in rows:
        sourcetype = row.get("series")
        if not sourcetype:
            continue
        kilobytes = float(row.get("kb") or 0.0)

        # The key is the thing the record describes, so a re-run overwrites rather than
        # duplicating. That is what makes this safe to run on a schedule.
        store.upsert(
            sourcetype,
            SourcetypeActivity(
                sourcetype=sourcetype, kilobytes=kilobytes, observed_at=observed_at
            ),
        )
        events.append((observed_at, {"sourcetype": sourcetype, "kilobytes": kilobytes}))

    # Checkpoints survive restarts. Saved only if this function returns without raising, so a
    # failed run repeats its window instead of skipping it.
    state.set("last_run", observed_at)

    # Returned records are indexed. `(timestamp, record)` sets the event time explicitly -
    # always do this when the data has its own notion of when it happened.
    return events


@scheduled(cron="17 * * * *")
def prune(splunk, state, log):
    """Drop activity records that have not been seen for a day."""
    cutoff = time.time() - 86400
    store = ACTIVITY.bind(splunk)

    # Filters are passed to KV store as-is. The query language is Mongo-shaped and stays
    # visible rather than being wrapped in a builder.
    stale = store.query({"observed_at": {"$lt": cutoff}})
    for record in stale:
        store.delete(record.sourcetype)

    log.info("pruned %d stale record(s)", len(stale))

    # Returning nothing means this job indexes nothing - which is why it declares no index or
    # sourcetype. A job is allowed to just do work.
