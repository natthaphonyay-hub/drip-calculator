"""Cross-check the web app engine against the independent model in reference.py.

Random scenarios cover every option (loading in each mode, rate change, carry-over bag,
bag-change time, multi-dose, undiluted syringes, every dose unit), plus a sweep over every
listed drug, preset mix and dose unit, plus exact-boundary cases.
usage: python3 tests/fuzz.py [random_count] [seed]
"""
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from collections import Counter
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference import reference, convert  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MASS = ["mcg", "mg", "g"]


def dose_units(u):
    if u in MASS:
        return ["mcg/min", "mcg/kg/min", "mcg/hr", "mcg/kg/hr", "mg/min", "mg/hr", "mg/kg/hr", "g/hr"]
    if u in ("unit", "IU"):
        return [u + "/hr", u + "/kg/hr", u + "/min", "mU/min"]
    return [u + "/hr", u + "/kg/hr", u + "/min", u + "/kg/min"]


def family(u):
    if u in MASS:
        return MASS
    if u in ("unit", "IU"):
        return [u, "mU"]
    return [u]


def sig(x, n=3):
    if x == 0:
        return 0.0
    d = n - int(math.floor(math.log10(abs(x)))) - 1
    return float(round(x, d))


def bag_volume(p):
    a = p["pkgAmount"]
    drug = p["mixAmount"] * (a if p["mixUnit"] == "cont" else 1)
    vc = p.get("pkgVolume")
    dv = drug / a * vc if vc else None
    if p.get("diluent") == "none":
        return drug, dv
    return drug, p["mixVolume"] + (dv if p.get("includeDrugVolume") and dv else 0)


def dose_for_rate(p, unit, du, target, weight):
    """The dose a prescriber would write (3 significant figures) for roughly `target` ml/hr."""
    drug, bv = bag_volume(p)
    per_hr = target * drug / bv  # package unit per hour
    num = du.split("/")[0]
    v = float(convert(F(repr(per_hr)), unit, num))
    if "kg" in du.split("/"):
        v /= weight
    if du.endswith("/min"):
        v /= 60
    return sig(v)


def gen_random(rng):
    unit = rng.choice(["mg", "mcg", "g", "mEq", "unit", "IU", "mmol"])
    a = rng.choice([1, 2, 4, 5, 10, 15, 20, 25, 40, 44.6, 50, 100, 150, 200, 250, 500, 1000, 25000])
    vc = rng.choice([None, 1, 2, 3, 4, 5, 10, 20, 50])
    und = vc is not None and rng.random() < 0.12
    p = {"pkgAmount": a, "pkgUnit": unit, "pkgVolume": vc, "diluent": "none" if und else rng.choice(["NSS", "D5W", "D5S"])}
    if rng.random() < 0.3:
        p.update(mixUnit="cont", mixAmount=rng.choice([0.5, 1, 1.5, 2, 2.5, 3, 4, 6]))
    else:
        p.update(mixUnit="drug", mixAmount=sig(a * rng.choice([0.2, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6]), 6))
    if not und:
        p["mixVolume"] = rng.choice([20, 50, 100, 250, 500, 1000]) if rng.random() < 0.8 else round(rng.uniform(10, 1000), 1)
    p["includeDrugVolume"] = rng.random() < 0.3
    target = rng.choice([0.5, 1, 2.5, 5, 7.5, 10, 12.5, 20, 21.6, 30, 33.3, 50, 62.5, 80, 100, 125, 200, 300]) \
        if rng.random() < 0.7 else round(rng.uniform(0.3, 300), 2)
    weight = rng.choice([3.5, 10, 45, 60, 70, 82.5, 120])
    if rng.random() < 0.5:
        p.update(rateMode="mlhr", rate=target)
    else:
        du = rng.choice(dose_units(unit))
        p.update(rateMode="dose", doseUnit=du, weight=weight, doseValue=dose_for_rate(p, unit, du, target, weight))
    if rng.random() < 0.25:
        k = rng.choice([0.25, 0.5, 0.75, 1.5, 2])
        after = rng.choice([0.5, 1, 2, 6, 12, 23.5, 30])
        if p["rateMode"] == "dose":
            p.update(step2On=True, step2After=after, step2Value=sig(p["doseValue"] * k))
        else:
            p.update(step2On=True, step2After=after, step2Value=sig(p["rate"] * k))
    if rng.random() < 0.35:
        lu = rng.choice(family(unit))
        per_kg = rng.random() < 0.35
        amount_pkg = a * rng.choice([0.05, 0.1, 0.5, 1, 1.5, 2, 3])
        amt = float(convert(F(repr(amount_pkg)), unit, lu))
        if per_kg:
            amt /= weight
            p["weight"] = p.get("weight", weight)
        p.update(loadOn=True, loadAmount=sig(amt), loadUnit=lu, loadPerKg=per_kg,
                 loadMode=rng.choice(["separate", "separate", "same"]),
                 loadVolume=rng.choice([0, 50, 100, 250]), loadMinutes=rng.choice([0, 5, 10, 15, 20, 30, 60, 120]))
    p["hours"] = rng.choice([1, 6, 8, 12, 24, 24, 36, 48, 72, 96]) if rng.random() < 0.85 else round(rng.uniform(0.5, 96), 2)
    _, bv = bag_volume(p)
    if rng.random() < 0.25:
        p["carryVolume"] = round(bv * rng.choice([0.05, 0.3, 0.5, 0.9, 1.2]), 2)
        if rng.random() < 0.5:
            p["carryHung"] = rng.choice([1, 6, 12, 20, 30])
    if rng.random() < 0.3:
        p["maxHang"] = rng.choice([2, 4, 6, 8, 12, 24, 48])
    p["multiDose"] = rng.random() < 0.25
    return p


def gen_presets(drugs, rng):
    out = []
    for d in drugs:
        for m in d["mixes"]:
            und = m["v"] == 0
            dils = ["none"] if und else [x for x in (d["diluents"] or ["NSS", "D5W"]) if x != "none"]
            for dil in dils:
                base = {"pkgAmount": d["amount"], "pkgUnit": d["unit"], "pkgVolume": d["volume"], "diluent": dil,
                        "mixAmount": m["a"], "mixUnit": "cont" if m.get("unit") == "cont" else "drug",
                        "mixVolume": m["v"], "includeDrugVolume": bool(m.get("addDrugVol"))}
                for du in ["ml/hr"] + dose_units(d["unit"]):
                    for target in (rng.choice([1, 2.5, 5]), rng.choice([10, 21.6, 33.3]), rng.choice([62.5, 100, 150])):
                        p = dict(base)
                        weight = rng.choice([50, 60, 72.5])
                        if du == "ml/hr":
                            p.update(rateMode="mlhr", rate=target)
                        else:
                            p.update(rateMode="dose", doseUnit=du, weight=weight, doseValue=dose_for_rate(p, d["unit"], du, target, weight))
                        p["hours"] = rng.choice([12, 24, 48, 72])
                        p["multiDose"] = bool(d.get("multiDose")) or rng.random() < 0.3
                        if rng.random() < 0.3:
                            p["maxHang"] = rng.choice([12, 24])
                        if d.get("loading") and rng.random() < 0.6:
                            l = d["loading"]
                            p.update(loadOn=True, loadAmount=l["amount"], loadUnit=l["unit"], loadPerKg=l["perKg"], loadMode=l["mode"],
                                     loadVolume=l.get("volume", 0), loadMinutes=l.get("minutes", 0), weight=weight)
                        if d.get("regimen") and rng.random() < 0.5:
                            g = d["regimen"]
                            p.update(rateMode="dose", doseUnit=g["doseUnit"], doseValue=g["doseValue"], step2On=True,
                                     step2After=g["step2After"], step2Value=g["step2Value"])
                        out.append(p)
    return out


def gen_boundaries():
    """Exact fits: bag empties exactly at the end, change time equals empty time, change at a bag boundary."""
    out = []
    for bv, rate, h in [(500, 25, 20), (100, 25, 24), (1020, 85, 24), (250, 10.5, 47.619047619047616), (50, 12.5, 24), (1000, 125, 8)]:
        out.append({"pkgAmount": 4, "pkgUnit": "mg", "pkgVolume": 4, "diluent": "D5W", "mixAmount": 8, "mixUnit": "drug",
                    "mixVolume": bv, "rateMode": "mlhr", "rate": rate, "hours": h})
    for hang in (4, 20, 24):
        out.append({"pkgAmount": 4, "pkgUnit": "mg", "pkgVolume": 4, "diluent": "D5W", "mixAmount": 8, "mixUnit": "drug",
                    "mixVolume": 100, "rateMode": "mlhr", "rate": 5, "hours": 48, "maxHang": hang})
    for after in (4, 8, 10):
        out.append({"pkgAmount": 4, "pkgUnit": "mg", "pkgVolume": 4, "diluent": "D5W", "mixAmount": 8, "mixUnit": "drug",
                    "mixVolume": 100, "rateMode": "mlhr", "rate": 25, "step2On": True, "step2After": after, "step2Value": 12.5, "hours": 24})
    for carry, hung in [(100, 0), (120, 0), (50, 22), (50, 24), (50, 30)]:
        out.append({"pkgAmount": 4, "pkgUnit": "mg", "pkgVolume": 4, "diluent": "D5W", "mixAmount": 8, "mixUnit": "drug",
                    "mixVolume": 100, "rateMode": "mlhr", "rate": 5, "hours": 24, "carryVolume": carry, "carryHung": hung, "maxHang": 24})
    return out


def close(a, b, tol):
    return abs(float(a) - float(b)) <= tol


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 2569
    rng = random.Random(seed)
    drugs = json.loads(subprocess.run(["node", os.path.join(HERE, "run-engine.mjs"), "--drugs"], capture_output=True, text=True, check=True).stdout)
    groups = {"random": [gen_random(rng) for _ in range(n)], "preset sweep": gen_presets(drugs, rng), "boundary": gen_boundaries()}
    scen = [s for g in groups.values() for s in g]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(scen, f)
        path = f.name
    js = json.loads(subprocess.run(["node", os.path.join(HERE, "run-engine.mjs"), path], capture_output=True, text=True, check=True).stdout)
    os.unlink(path)

    bad, label_diffs, cover, ties = [], 0, Counter(), []
    i = 0
    for gname, items in groups.items():
        for p in items:
            ref, got = reference(p), js[i]
            i += 1
            cover[gname] += 1
            if ref["ok"] != got["ok"]:
                bad.append((gname, p, "ok", ref["ok"], got))
                continue
            if not ref["ok"]:
                cover["not computable (both agree)"] += 1
                continue
            for k in ("loadOn", "step2On", "carryVolume", "maxHang", "multiDose", "includeDrugVolume"):
                if p.get(k):
                    cover[k] += 1
            if p.get("loadOn"):
                cover["loading " + p.get("loadMode", "separate") + (" push" if not p.get("loadMinutes") else "")] += 1
            if p.get("diluent") == "none":
                cover["undiluted"] += 1
            cover["dose mode" if p["rateMode"] == "dose" else "ml/hr mode"] += 1
            bv = float(ref["bagVolume"])
            checks = [
                ("bags", ref["bags"] == got["bags"]),
                ("containers", ref["containers"] == got["containers"]),
                ("loadContainers", ref["loadContainers"] == got["loadContainers"]),
                ("totalContainers", ref["totalContainers"] == got["totalContainers"]),
                ("totalVolume", close(ref["totalVolume"], got["totalVolume"], 1e-7 * max(1.0, float(ref["totalVolume"])))),
                ("leftoverEnd", close(ref["leftoverEnd"], got["leftoverEnd"], 1e-6 * max(1.0, bv))),
                ("rate", close(ref["rate"], got["rate"], 1e-9 * max(1.0, float(ref["rate"])))),
                ("note charset", got["noteSafe"] and not got["noteHasNaN"]),
            ]
            failed = [name for name, okay in checks if not okay]
            if failed:
                bad.append((gname, p, failed, {k: (float(v) if isinstance(v, F) else v) for k, v in ref.items()}, got))
            elif ref["ends"] != got["ends"]:
                label_diffs += 1  # same counts and volumes; only an exact tie labelled differently
                ties.append((p, ref['ends'], got['ends'], float(ref['leftoverEnd']), got['leftoverEnd']))

    total = len(scen)
    print(f"scenarios: {total}  (" + ', '.join(f'{g} {len(s)}' for g, s in groups.items()) + ")")
    print("coverage:", ", ".join(f"{k} {v}" for k, v in sorted(cover.items())))
    print(f"mismatches: {len(bad)}   tie labels only: {label_diffs}")
    for t in ties[:3]:
        print('tie:', json.dumps(t[0], ensure_ascii=False), '| reference', t[1], t[3], '| app', t[2], t[4])
    for b in bad[:8]:
        print("\n--- MISMATCH", b[0], b[2])
        print("scenario:", json.dumps(b[1], ensure_ascii=False))
        print("reference:", b[3])
        print("app:", b[4])
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
