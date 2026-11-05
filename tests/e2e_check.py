"""Checks what the real page shows against the independent model.
usage: python3 tests/e2e_check.py   (runs tests/e2e-ui.mjs, needs Google Chrome)"""
import json
import os
import re
import subprocess
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference import reference  # noqa: E402
from limits_ref import limits_reference  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAFE = re.compile(r"^[\t\n\x20-\x7E฀-๿]*$")


def intended(c, drugs):
    """The form must hold exactly what was clicked: package, preset mix, diluent, rate, loading."""
    d = drugs[c["drug"]]
    m = d["mixes"][c["mix"]]
    p = c["params"]
    exp = {"pkgAmount": d["amount"], "pkgUnit": d["unit"], "pkgVolume": d["volume"], "mixAmount": m["a"],
           "mixUnit": "cont" if m.get("unit") == "cont" else "drug", "includeDrugVolume": bool(m.get("addDrugVol")),
           "diluent": "none" if m["v"] == 0 else c["dil"], "multiDose": bool(d.get("multiDose"))}
    if m["v"]:
        exp["mixVolume"] = m["v"]
    if c["mode"] == "mlhr":
        exp.update(rateMode="mlhr", rate=10)
    else:
        exp.update(rateMode="dose", weight=60, doseUnit=d["orderUnit"])
    if c["mode"] == "special":
        l = d["loading"]
        exp.update(loadOn=True, loadAmount=l["amount"], loadUnit=l["unit"], loadPerKg=l["perKg"], loadMode=l["mode"],
                   loadMinutes=l["minutes"])
        if l["mode"] != "same":
            exp["loadVolume"] = l["volume"]
        if d.get("regimen"):
            g = d["regimen"]
            exp.update(doseUnit=g["doseUnit"], doseValue=g["doseValue"], step2On=True, step2After=g["step2After"], step2Value=g["step2Value"])
    else:
        exp.update(loadOn=False, step2On=False)
    return [k for k, v in exp.items() if p.get(k) != v and not (p.get(k) is None and v in (0, None))]


def main():
    raw = subprocess.run(["node", os.path.join(HERE, "e2e-ui.mjs")], capture_output=True, text=True, check=True).stdout
    drugs = {d["id"]: d for d in json.loads(subprocess.run(["node", os.path.join(HERE, "run-engine.mjs"), "--drugs"],
                                                          capture_output=True, text=True, check=True).stdout)}
    lim = json.loads(subprocess.run(["node", os.path.join(HERE, "run-engine.mjs"), "--limits-data"],
                                    capture_output=True, text=True, check=True).stdout)
    data = json.loads(raw)
    cases, bad, seen = data["cases"], [], Counter()
    for c in cases:
        if c["drug"] == "keyboard-kcl":
            seen["keyboard pick"] += 1
            if "KCl" not in c["picked"]:
                bad.append(("keyboard", c))
            continue
        if "error" in c:
            bad.append(("ui", c))
            continue
        ref = reference(c["params"])
        seen[c.get("mode", "custom")] += 1
        if c["drug"] != "custom" and c.get("mode") != "limits":
            wrong = intended(c, drugs)
            if wrong:
                bad.append(("form does not hold what was clicked: " + ", ".join(wrong), c))
                continue
        if not ref["ok"]:
            if c.get("mode") == "limits":
                bad.append(("a warning case must be computable", c))
            elif c["hero"] is not None:
                bad.append(("app shows a result the model refuses", c))
            continue
        # dose and rate warnings on screen = the independent model (rules that hit a rounding tie are left out)
        exp, ties = limits_reference(c["params"], lim["LIMITS"].get(c["drug"])) if c["drug"] != "custom" else ([], set())
        shown_w = sorted(tuple(x) for x in c["limits"] if x[0] not in ties)
        want_w = sorted((i, s, lv) for i, s, _, lv in exp if i not in ties)
        seen["warnings shown"] += len(shown_w)
        if c.get("mode") == "limits":
            seen["warning cases computed"] += 1
        want_note = c["drug"] == "custom" or c["drug"] in lim["LIMITS_NOTE"] or bool(exp)
        if shown_w != want_w:
            bad.append((f"warnings {shown_w} != model {want_w}", c))
        elif bool(c["limitsNote"]) != want_note:
            bad.append(("note under the warnings", c))
        elif any(re.search(r"NaN|undefined|Infinity|null|\$\{", t) for t in c["limitText"]):
            bad.append(("warning text", c))
        elif c["hero"] != ref["totalContainers"]:
            bad.append((f"hero {c['hero']} != model {ref['totalContainers']}", c))
        elif not SAFE.match(c["note"]) or re.search(r"NaN|undefined|Infinity|null", c["note"]):
            bad.append(("note text", c))
        elif c["drug"] == "custom" and c["dilChips"] < 6:
            bad.append(("custom drug should show every diluent", c))
    print(f"page cases: {len(cases)} ({', '.join(f'{k} {v}' for k, v in sorted(seen.items()))})")
    print(f"JS errors on the page: {len(data['errors'])}")
    for e in data["errors"][:5]:
        print("  ", e[:300])
    print(f"mismatches: {len(bad)}")
    for why, c in bad[:8]:
        print("---", why, json.dumps({k: c.get(k) for k in ("drug", "mix", "dil", "mode", "hero", "empty")}, ensure_ascii=False))
    sys.exit(1 if bad or data["errors"] else 0)


if __name__ == "__main__":
    main()
