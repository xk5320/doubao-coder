import re,sys
p=r"C:\Users\Administrator\AppData\Local\Doubao\Application\app\mcp_helper.dll"
d=open(p,"rb").read()
s=[m.group().decode("latin1") for m in re.finditer(rb"[\x20-\x7e]{6,}",d)]
keys=("jsonrpc","tools/call","tools/list","initialize","notifications/","mcp","Mcp","MCP","stdio","sse","capabilities","serverInfo")
seen=set()
for x in s:
    if any(k in x for k in keys) and x not in seen:
        seen.add(x); print(repr(x))
    if len(seen)>60: break
