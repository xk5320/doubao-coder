import os, sys, inspect, json
sys.path.insert(0, r"C:\\Users\\Administrator\\AppData\\Local\\Doubao\\Application\\app\\task-mode-resource\\python-packages")
try:
    import seed_computer_use as cu
    names = list(getattr(cu, "__all__", []))
    out = {"ok": True, "count": len(names), "names": names, "sigs": {}}
    for n in names[:6]:
        try:
            out["sigs"][n] = str(inspect.signature(getattr(cu, n)))
        except Exception as e:
            out["sigs"][n] = "sig-error: %s" % e
    print(json.dumps(out, ensure_ascii=False)[:800])
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
