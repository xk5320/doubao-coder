import sys, json, traceback
sys.path.insert(0, r"C:\\Users\\Administrator\\AppData\\Local\\Doubao\\Application\\app\\task-mode-resource\\python-packages")
import seed_computer_use as cu
try:
    apps = cu.list_apps()
    print(json.dumps({"ok": True, "n": len(apps), "first": apps[:3]}, ensure_ascii=False)[:500])
except Exception as e:
    print(json.dumps({"ok": False, "type": type(e).__name__, "err": str(e)[:300]}, ensure_ascii=False))
