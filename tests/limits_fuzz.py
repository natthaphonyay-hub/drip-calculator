"""Cross-check the dose and rate warnings of the web app against limits_ref.py.

Scenarios aim at the edges: rates, concentrations, loadings, order lengths and 24-hour totals are set at each
threshold of each rule times a factor just below, at, or just above it, plus fully random orders.
usage: python3 tests/limits_fuzz.py [count] [seed]
"""
import json
import os
import random
import subprocess
import sys
import tempfile
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from limits_ref import limits_reference  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FACTORS = [0.5, 0.9, 0.99, 0.9993, 0.999, 1, 1.0004, 1.0007, 1.001, 1.004, 1.006, 1.01, 1.1, 2, 5]


def node(*args):
    return json.loads(subprocess.run(["node", os.path.join(HERE, "run-engine.mjs"), *args],
                                     capture_output=True, text=True, check=True).stdout)


MASS = {"g": 1000, "mg": 1, "mcg": 0.001}
UNITS = {"unit": 1, "IU": 1, "mU": 0.001}


def conv(v, a, b):
    if a == b:
        return v
    for t in (MASS, UNITS):
        if a in t and b in t:
            return v * t[a] / t[b]
    return None


def per_hour_for(v, unit, pkg, w):
    parts = unit.split("/")
    x = conv(v, parts[0], pkg)
    if "kg" in parts:
        x *= w
    return x * 60 if parts[-1] == "min" else x / 24 if parts[-1] == "24hr" else x


def scenario(rng, d, rules):
    m = rng.choice(d["mixes"])
    und = m["v"] == 0
    dils = d["diluents"] or ["NSS", "D5W", "none"]
    p = {"drugId": d["id"], "pkgAmount": d["amount"], "pkgUnit": d["unit"], "pkgVolume": d["volume"],
         "diluent": "none" if und else rng.choice([x for x in dils if x != "none"] or ["NSS"]),
         "mixAmount": m["a"], "mixUnit": "cont" if m.get("unit") == "cont" else "drug", "mixVolume": m["v"],
         "includeDrugVolume": bool(m.get("addDrugVol")), "multiDose": bool(d.get("multiDose")),
         "rateMode": "mlhr", "rate": round(10 ** rng.uniform(-1, 2.7), 3), "hours": rng.choice([1, 6, 12, 23, 24, 25, 36, 48, 72])}
    if rng.random() < 0.25 and not und:  # a mix of your own
        p.update(mixUnit="drug", mixAmount=round(d["amount"] * 10 ** rng.uniform(-1, 1.3), 4), mixVolume=rng.choice([20, 50, 100, 250, 500, 1000]))
    w = None if rng.random() < 0.3 else round(rng.uniform(3, 150), 1)
    if w:
        p["weight"] = w
    if rng.random() < 0.4:
        p.update(loadOn=True, loadMode=rng.choice(["separate", "same"]), loadVolume=rng.choice([0, 50, 100]),
                 loadMinutes=rng.choice([0, 2, 5, 9.9, 10, 10.1, 20, 30, 60]), loadUnit=d["unit"], loadPerKg=False,
                 loadAmount=round(d["amount"] * 10 ** rng.uniform(-1, 1), 4))
        if w and rng.random() < 0.4:
            p.update(loadPerKg=True, loadAmount=round(p["loadAmount"] / 60, 6))
    if rng.random() < 0.3:
        p.update(step2On=True, step2After=rng.choice([0.5, 2, 6, 12, 30]), step2Value=round(10 ** rng.uniform(-1, 2.7), 3))
    # aim one number at a threshold of one rule
    if rules and rng.random() < 0.8:
        L = rng.choice(rules)
        edge = rng.choice([x for x in (L.get("low"), L.get("high"), L.get("max")) if x is not None])
        v = edge * rng.choice(FACTORS)
        per_kg = L.get("perKg") or "kg" in L["unit"].split("/")
        if per_kg and not w:
            p["weight"] = w = 60
        a = d["amount"]
        drug = p["mixAmount"] * (a if p["mixUnit"] == "cont" else 1)
        bag = drug / a * d["volume"] if und else p["mixVolume"] + (drug / a * d["volume"] if p["includeDrugVolume"] else 0)
        conc = drug / bag
        k = L["kind"]
        if k in ("dose", "rate"):
            ph = per_hour_for(v, L["unit"], d["unit"], w)
            if k == "rate" and p.get("loadOn") and rng.random() < 0.5:
                p["loadMinutes"] = max(0.5, round(conv(p["loadAmount"] * (w if p.get("loadPerKg") else 1), d["unit"], d["unit"]) / ph * 60, 6))
            else:
                p["rate"] = ph / conc
        elif k == "day":
            p.pop("loadOn", None)
            p["step2On"] = False
            p["rate"] = conv(v, L["unit"], d["unit"]) / 24 / conc
        elif k == "conc" and not und:
            num, per = L["unit"].split("/")
            p.update(mixUnit="drug", includeDrugVolume=False, mixVolume=100,
                     mixAmount=conv(v, num, d["unit"]) / (1000 if per == "L" else 1) * 100)
        elif k == "load":
            p.update(loadOn=True, loadMode=p.get("loadMode", "separate"), loadVolume=p.get("loadVolume", 100),
                     loadMinutes=p.get("loadMinutes", 20), loadUnit=L["unit"], loadPerKg=bool(L.get("perKg")), loadAmount=v)
        elif k == "loadMin":
            p.update(loadOn=True, loadMode=p.get("loadMode", "same"), loadVolume=p.get("loadVolume", 0),
                     loadUnit=p.get("loadUnit", d["unit"]), loadPerKg=p.get("loadPerKg", False),
                     loadAmount=p.get("loadAmount", d["amount"]), loadMinutes=v)
        elif k == "hours":
            p["hours"] = v
    return p


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
    drugs = node("--drugs")
    data = node("--limits-data")
    limits = data["LIMITS"]
    scen = []
    for _ in range(n):
        d = rng.choice(drugs)
        scen.append(scenario(rng, d, limits.get(d["id"])))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(scen, f)
        path = f.name
    try:
        got = node("--limits", path)
    finally:
        os.unlink(path)
    bad, ties, seen = [], 0, Counter()
    for p, g in zip(scen, got):
        rules = limits.get(p["drugId"])
        exp, tie_ids = limits_reference(p, rules)
        if not g["ok"]:
            seen["not computable"] += 1
            continue
        app = sorted((w["id"], w["seg"], w["side"], w["level"]) for w in g["warnings"])
        ref = sorted(exp)
        if tie_ids:
            ties += 1
            app = [x for x in app if x[0] not in tie_ids]
            ref = [x for x in ref if x[0] not in tie_ids]
        for x in ref:
            seen[f"{x[3]}"] += 1
        if not exp:
            seen["no warning"] += 1
        if app != ref:
            bad.append((p, app, ref))
    print(f"scenarios: {len(scen)}  drugs: {len({p['drugId'] for p in scen})}")
    print("warnings expected: " + ", ".join(f"{k} {v}" for k, v in sorted(seen.items())))
    print(f"mismatches: {len(bad)}   rounding ties skipped: {ties}")
    for p, app, ref in bad[:6]:
        print("--- app", app, "\n    ref", ref, "\n   ", json.dumps(p))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
