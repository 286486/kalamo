# Pango 1.50.12's line breaks, as Inkscape 1.2.2 wraps at them (#222). Reads one JSON string per line and
# prints each as its units, a JSON array, each unit ending at a break opportunity (`pango_get_log_attrs`).
import ctypes, json, sys
p = ctypes.CDLL("libpango-1.0.so.0")
p.pango_language_from_string.restype = ctypes.c_void_p
en = p.pango_language_from_string(b"en")
p.pango_get_log_attrs.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
for line in sys.stdin:
    s = json.loads(line)
    b = s.encode()
    n = len(s) + 1
    attrs = (ctypes.c_uint32 * n)()
    p.pango_get_log_attrs(b, len(b), -1, en, attrs, n)
    units, u = [], ""
    for i, ch in enumerate(s):
        if i and attrs[i] & 1 and u:
            units.append(u); u = ""
        u += ch
    if u: units.append(u)
    print(json.dumps(units, ensure_ascii=False, separators=(",", ":")))
