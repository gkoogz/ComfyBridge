"""Only an explicitly cancelled, bridge-owned isolated execution may be recycled."""
def can_recover(owned, elapsed, queue, targets):
    running = {item[1] for item in queue.get('queue_running', [])}
    return bool(owned and elapsed >= 120 and running and running <= targets
                and not queue.get('queue_pending'))
