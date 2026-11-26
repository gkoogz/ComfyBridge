import json
import math
import uuid

from civitai_browser import ident


DEFAULTS = {'offset': 0, 'disabled': False, 'banned': False}


def merge(current, changes, revision, auto_disabled=False):
    result = dict(current)
    revisions = dict(current.get('revisions', {}))
    for field, edit in changes.items():
        old = current.get(field, DEFAULTS[field])
        proposed = edit['value']
        concurrent = revisions.get(field, '') != edit['revision'] or old != edit['base']
        if field == 'disabled' and auto_disabled:
            offset = changes.get('offset', {})
            numeric_conflict = current.get('revisions',{}).get('offset','') != offset.get('revision','') or current.get('offset',0) != offset.get('base',0)
            # A zero caused by a vote is subordinate to the winning numeric edit.
            if (old and not current.get('disabledByVote') and concurrent) or (numeric_conflict and offset.get('value',0)<current.get('offset',0)):
                continue
        if field == 'disabled':
            result['disabledByVote'] = auto_disabled
        if concurrent and not (field == 'disabled' and auto_disabled and current.get('disabledByVote')):
            # An unseen ban holds even if the offline device tried to unban.
            proposed = max(old, proposed)
        if proposed != old:
            result[field] = proposed
            revisions[field] = revision
    result['revisions'] = revisions
    return result


def sync(browser, payload=None):
    with browser.action_lock:
        me, token = browser.account(cached=True)
        account = me['id']
        applied = []
        if payload is not None:
            if str(payload.get('account')) != account:
                raise ValueError('Civitai account changed. Reopen Browse.')
            operations = payload.get('changes', [])
            if not isinstance(operations, list) or len(operations) > 100 or any(not isinstance(op,dict) for op in operations):
                raise ValueError('Send at most 100 preference changes.')
            overrides = browser.setting(account, 'weight-overrides', {})
            with browser.db() as db:
                db.execute('BEGIN IMMEDIATE')
                for operation in operations:
                    try:
                        revision = str(uuid.UUID(operation.get('requestId','')))
                    except (ValueError, TypeError, AttributeError):
                        raise ValueError('Invalid request identifier.')
                    subject = operation.get('kind')
                    if subject not in ('tag', 'creator'):
                        raise ValueError('Unknown preference type.')
                    key = subject + ':' + str(ident(operation.get('id')))
                    changes = operation.get('changes')
                    if not isinstance(changes, dict) or not changes.keys() <= DEFAULTS.keys():
                        raise ValueError('Unknown preference field.')
                    for field, edit in changes.items():
                        if not isinstance(edit,dict) or not {'base','value','revision'} <= edit.keys() or not isinstance(edit['revision'],str):
                            raise ValueError('Invalid preference change.')
                        initial = DEFAULTS[field]
                        types = (int,float) if field == 'offset' else (type(initial),)
                        if any(type(edit[k]) not in types or abs(edit[k]) > 1000000 or not math.isfinite(edit[k]) for k in ('base', 'value')):
                            raise ValueError('Invalid preference value.')
                        if edit['revision']:
                            uuid.UUID(edit['revision'])
                    body = json.dumps(operation, sort_keys=True)
                    prior = db.execute('SELECT payload FROM actions WHERE account=? AND id=?',(account,revision)).fetchone()
                    if prior:
                        if prior[0] != body:
                            raise ValueError('Action identifier was already used.')
                    else:
                        change = merge(overrides.get(key, {}), changes, revision, operation.get('autoDisabled') is True)
                        change['name'] = str(operation.get('name') or change.get('name') or key)[:200]
                        overrides[key] = change
                        db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(account,revision,body,'done','{}'))
                    applied.append(revision)
                browser.assert_account(account, token)
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)',(account,'weight-overrides',json.dumps(overrides)))
        return dict(account=account, items=browser.preference_rows(account), applied=applied)
