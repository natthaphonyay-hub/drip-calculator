"""Independent model of the dose and rate warnings (LIMITS in index.html), written from the rules, not from the JS.

Exact fractions; the plan for the first 24 hours is integrated segment by segment. Values are compared the way the
app prints them: 3 significant figures below 1, 2 decimals below 100, 1 decimal below 1,000, whole numbers above,
half up. A value that sits on a rounding half-point is a "tie" (the app rounds the floating-point value, which may
fall either side), and the caller skips that rule.
"""
from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction as F

from reference import reference, convert, fr

RANK = {"danger": 0, "warn": 1, "info": 2}


def _dec(x):
    with localcontext() as c:
        c.prec = 60
        return Decimal(x.numerator) / Decimal(x.denominator)


def shown(x):
    """(the number the app prints as a Decimal, tie?) for a Fraction."""
    x = F(x)
    if x == 0:
        return Decimal(0), False
    d = _dec(x)
    a = abs(d)
    if a < 1:
        q = Decimal(1).scaleb(d.adjusted() - 2)
    elif a < 100:
        q = Decimal("0.01")
    elif a < 1000:
        q = Decimal("0.1")
    else:
        q = Decimal(1)
    r = d.quantize(q, rounding=ROUND_HALF_UP)
    frac = (a / q) % 1  # position between two printed values
    tie = abs(frac - Decimal("0.5")) < Decimal("1e-7")
    return r, tie


def rate_in(per_hour, pkg, unit, w):
    parts = unit.split("/")
    v = convert(per_hour, pkg, parts[0])
    if v is None:
        return None
    if "kg" in parts:
        v /= w
    if parts[-1] == "min":
        v /= 60
    elif parts[-1] == "24hr":
        v *= 24
    return v


def conc_in(conc, pkg, unit):
    num, per = unit.split("/")
    v = convert(conc, pkg, num)
    return None if v is None else v * (1000 if per == "L" else 1)


def limits_reference(p, rules):
    """List of (id, seg, side, level) and the set of rule ids that hit a rounding tie."""
    ref = reference(p)
    if not ref["ok"] or not rules:
        return [], set()
    pkg = p["pkgUnit"]
    A = fr(p["pkgAmount"])
    mix_drug = fr(p["mixAmount"]) * (A if p.get("mixUnit") == "cont" else 1)
    conc = mix_drug / ref["bagVolume"]
    w = fr(p["weight"]) if p.get("weight") else None
    if w is not None and w <= 0:
        w = None
    main = ref["rate"] * conc
    step2 = ref["rate2"] * conc if ref["rate2"] is not None else None

    load = None
    if p.get("loadOn"):
        amt = convert(fr(p["loadAmount"]), p.get("loadUnit") or pkg, pkg)
        if p.get("loadPerKg"):
            amt *= fr(p["weight"])
        mins = fr(p["loadMinutes"]) if p.get("loadMinutes") and p["loadMinutes"] > 0 else F(0)
        load = {"drug": amt, "hours": mins / 60, "mode": p.get("loadMode")}

    # drug over the first 24 hours of the plan
    day = F(0)
    lh = load["hours"] if load else F(0)
    if load:
        if load["mode"] == "same" and lh > 0:
            day += load["drug"] * min(lh, F(24)) / lh
        else:
            day += load["drug"]
    segs = []
    if p.get("step2On"):
        at = lh + fr(p["step2After"])
        segs = [(lh, at, main), (at, None, step2)]
    else:
        segs = [(lh, None, main)]
    for a, b, dose in segs:
        end = F(24) if b is None else min(b, F(24))
        if end > a:
            day += dose * (end - a)

    out, ties, need_weight = [], set(), False
    for L in rules:
        if L.get("noWeight") and w is not None:
            continue
        per_kg = L.get("perKg") or "kg" in L["unit"].split("/")
        if per_kg and w is None:
            need_weight = True
            continue
        vals = []
        k = L["kind"]
        if k in ("dose", "rate"):
            if k == "rate" and load:
                vals.append(("load", rate_in(load["drug"] / load["hours"], pkg, L["unit"], w) if load["hours"] > 0 else "nil"))
            vals.append(("main", rate_in(main, pkg, L["unit"], w)))
            if step2 is not None:
                vals.append(("step2", rate_in(step2, pkg, L["unit"], w)))
        elif k == "load":
            if load:
                v = convert(load["drug"], pkg, L["unit"])
                vals.append(("load", None if v is None else v / (w if L.get("perKg") else 1)))
        elif k == "loadMin":
            if load:
                vals.append(("load", load["hours"] * 60))
        elif k == "conc":
            vals.append(("bag", conc_in(conc, pkg, L["unit"])))
        elif k == "day":
            vals.append(("day", convert(day, pkg, L["unit"])))
        elif k == "hours":
            vals.append(("order", fr(p["hours"])))
        for seg, v in vals:
            if v == "nil":
                out.append((L["id"], seg, "max", "info"))
                continue
            if v is None:
                continue
            s, tie = shown(v)
            if tie:
                ties.add(L["id"])
            side = None
            if L.get("max") is not None and s > shown(fr(L["max"]))[0]:
                side = "max"
            elif L.get("high") is not None and s > shown(fr(L["high"]))[0]:
                side = "high"
            elif L.get("low") is not None and s < shown(fr(L["low"]))[0]:
                side = "low"
            if side:
                level = "danger" if side == "max" else (L.get("highLevel") or "warn") if side == "high" else (L.get("lowLevel") or "info")
                out.append((L["id"], seg, side, level))
    if need_weight:
        out.append(("weight", "", "", "info"))
    out.sort(key=lambda t: RANK[t[3]])
    return out, ties
