"""Independent model of the Drip Calculator engine, written from the rules (not from the JS code).

Uses exact fractions and a cumulative-volume method: a bag opened at time s with content S
ends at the first time when the volume given since s reaches S, or when its change time is up,
or when the order ends. The web app walks the timeline step by step in floating point instead,
so agreement between the two is a real cross-check.
"""
from fractions import Fraction as F
import math

MASS = {"g": F(1000), "mg": F(1), "mcg": F(1, 1000)}
UNITS = {"unit": F(1), "IU": F(1), "mU": F(1, 1000)}


def fr(x):
    """Number -> exact Fraction of the decimal it was written as."""
    if x is None:
        return None
    if isinstance(x, float):
        return F(repr(x))
    return F(x)


def convert(v, a, b):
    if a == b:
        return v
    if a in MASS and b in MASS:
        return v * MASS[a] / MASS[b]
    if a in UNITS and b in UNITS:
        return v * UNITS[a] / UNITS[b]
    return None


def per_hour(value, dose_unit, pkg_unit, weight):
    parts = dose_unit.split("/")
    v = convert(value, parts[0], pkg_unit)
    if v is None:
        return None
    if "kg" in parts:
        v *= weight
    if parts[-1] == "min":
        v *= 60
    return v


def pos(p, k):
    v = p.get(k)
    return v is not None and v > 0


def reference(p):
    und = p.get("diluent") == "none"
    dose = p.get("rateMode") == "dose"
    ok = pos(p, "pkgAmount") and pos(p, "mixAmount") and pos(p, "hours")
    ok = ok and (pos(p, "pkgVolume") if und else pos(p, "mixVolume"))
    ok = ok and (pos(p, "doseValue") if dose else pos(p, "rate"))
    if p.get("step2On"):
        ok = ok and pos(p, "step2After") and pos(p, "step2Value")
    if p.get("loadOn"):
        ok = ok and pos(p, "loadAmount")
    need_weight = (dose and "kg" in p.get("doseUnit", "").split("/")) or (p.get("loadOn") and p.get("loadPerKg"))
    if need_weight:
        ok = ok and pos(p, "weight")
    if not ok:
        return {"ok": False}

    A = fr(p["pkgAmount"])
    unit = p["pkgUnit"]
    mix_drug = fr(p["mixAmount"]) * (A if p.get("mixUnit") == "cont" else 1)
    exact = mix_drug / A
    per_bag = math.ceil(exact)
    vc = fr(p["pkgVolume"]) if pos(p, "pkgVolume") else None
    drug_vol = exact * vc if vc else None
    if und:
        bag_v = drug_vol
    else:
        bag_v = fr(p["mixVolume"]) + (drug_vol if p.get("includeDrugVolume") and drug_vol else 0)
    conc = mix_drug / bag_v
    weight = fr(p.get("weight"))

    def ml_hr(v):
        if dose:
            ph = per_hour(fr(v), p["doseUnit"], unit, weight)
            return None if ph is None else ph / conc
        return fr(v)

    rate = ml_hr(p["doseValue"] if dose else p["rate"])
    rate2 = ml_hr(p["step2Value"]) if p.get("step2On") else None
    if rate is None or (p.get("step2On") and rate2 is None):
        return {"ok": False}

    load = None
    if p.get("loadOn"):
        d = convert(fr(p["loadAmount"]), p.get("loadUnit") or unit, unit)
        if d is None:
            return {"ok": False}
        if p.get("loadPerKg"):
            d *= weight
        hrs = fr(p["loadMinutes"]) / 60 if pos(p, "loadMinutes") else F(0)
        if p.get("loadMode") == "same":
            load = {"mode": "same", "drug": d, "volume": d / conc, "hours": hrs, "containers": 0}
        else:
            load = {"mode": "separate", "drug": d, "hours": hrs, "containers": math.ceil(d / A)}

    H = fr(p["hours"])
    start = min(H, load["hours"] if load else F(0))
    segs = []  # (t0, t1, ml/hr)
    if load and load["mode"] == "same" and load["hours"] > 0:
        segs.append((F(0), start, load["volume"] / load["hours"]))
    elif start > 0:
        segs.append((F(0), start, F(0)))
    step_at = start + fr(p["step2After"]) if p.get("step2On") else None
    if start < H:
        if p.get("step2On") and step_at < H:
            segs += [(start, step_at, rate), (step_at, H, rate2)]
        else:
            segs.append((start, H, rate))
    instant = load["volume"] if (load and load["mode"] == "same" and load["hours"] == 0) else F(0)

    def given(t):  # volume given from bags over [0, t], not counting the push at t = 0
        tot = F(0)
        for a, b, r in segs:
            if t <= a:
                break
            tot += r * (min(t, b) - a)
        return tot

    def time_for(target):  # earliest t with given(t) >= target, or None within the order
        tot = F(0)
        for a, b, r in segs:
            v = r * (b - a)
            if r > 0 and tot + v >= target:
                return a + (target - tot) / r
            tot += v
        return None

    def next_active(t):
        for a, b, r in segs:
            if b <= t:
                continue
            if r > 0:
                return max(a, t)
        return None

    hang = fr(p["maxHang"]) if pos(p, "maxHang") else None
    carry = fr(p["carryVolume"]) if pos(p, "carryVolume") else F(0)
    carry_hung = fr(p["carryHung"]) if pos(p, "carryHung") else F(0)

    rows, bags, used = [], 0, F(0)
    bag = None
    if carry:
        bag = {"carry": True, "start": F(0), "left": carry, "until": (hang - carry_hung) if hang is not None else None}
    t = F(0)
    pending = instant
    while True:
        if bag is None:
            if pending > 0:
                t_open = F(0)
            else:
                t_open = next_active(t)
                if t_open is None or t_open >= H:
                    break
            bags += 1
            if bags > 5000:
                return {"ok": False}
            bag = {"carry": False, "start": t_open, "left": bag_v, "until": (t_open + hang) if hang is not None else None}
            t = t_open
        if pending > 0:  # loading pushed from the bag at t = 0
            if bag["until"] is not None and bag["until"] <= 0:
                rows.append(("hang", bag)); bag = None; continue
            take = min(bag["left"], pending)
            bag["left"] -= take; pending -= take; used += take
            if bag["left"] == 0:
                rows.append(("empty", bag)); bag = None
            continue
        base = given(t)
        t_empty = time_for(base + bag["left"])
        u = bag["until"]
        if u is not None and u < t:
            u = t
        if t_empty is not None and (u is None or t_empty <= u) and t_empty <= H:
            used += bag["left"]; bag["left"] = F(0); t = t_empty
            rows.append(("empty", bag)); bag = None
        elif u is not None and u <= H:
            g = given(u) - base
            used += g; bag["left"] -= g; t = u
            rows.append(("hang", bag)); bag = None
        else:
            g = given(H) - base
            used += g; bag["left"] -= g; t = H
            rows.append(("orderEnd", bag)); bag = None
            break

    load_sep = load["drug"] if load and load["mode"] == "separate" else F(0)
    if_reuse = math.ceil(bags * exact) if bags else 0
    containers = if_reuse if p.get("multiDose") else bags * per_bag
    load_containers = load["containers"] if load and load["mode"] == "separate" else 0
    total_reuse = math.ceil((bags * mix_drug + load_sep) / A) if (bags or load_sep) else 0
    total = total_reuse if p.get("multiDose") else containers + load_containers
    last = rows[-1] if rows else None
    leftover = last[1]["left"] if last and last[0] == "orderEnd" else F(0)
    return {
        "ok": True, "bags": bags, "containers": containers, "loadContainers": load_containers,
        "totalContainers": total, "totalVolume": used, "leftoverEnd": leftover, "bagVolume": bag_v,
        "rate": rate, "rate2": rate2, "ends": [r[0] for r in rows],
    }
