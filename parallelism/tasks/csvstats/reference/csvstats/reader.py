def _infer(raw, quoted):
    if quoted:
        return raw
    s = raw.strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        return s


def _records(text):
    recs, row, field, quoted, inq, i, n = [], [], [], False, False, 0, len(text)
    started = False
    while i < n:
        c = text[i]
        if inq:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"'); i += 1
                else:
                    inq = False
            else:
                field.append(c)
        elif c == '"' and not "".join(field).strip():
            inq, quoted, field, started = True, True, [], True
        elif c == ",":
            row.append(("".join(field), quoted)); field, quoted, started = [], False, True
        elif c in "\r\n":
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            if started or field or row:
                row.append(("".join(field), quoted)); recs.append(row)
            row, field, quoted, started = [], [], False, False
        else:
            field.append(c); started = True
        i += 1
    if started or field or row:
        row.append(("".join(field), quoted)); recs.append(row)
    return recs


def parse_csv(text):
    recs = [r for r in _records(text) if not (len(r) == 1 and r[0][0].strip() == "" and not r[0][1])]
    if not recs:
        return []
    header = [h.strip() for h, _ in recs[0]]
    out = []
    for no, r in enumerate(recs[1:], start=2):
        if len(r) != len(header):
            raise ValueError(f"record {no}: expected {len(header)} fields, got {len(r)}")
        out.append({h: _infer(v, q) for h, (v, q) in zip(header, r)})
    return out
