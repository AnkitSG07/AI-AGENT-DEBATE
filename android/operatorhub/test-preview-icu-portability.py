#!/usr/bin/env python3
"""Check production preview regex literals against host ICU, Android's regex backend.

This is a portability check, not an Android handset notification test. The real
Android boundary is covered separately by NativeSystemInstrumentationTest.
"""
import ctypes
import ctypes.util
import json
from pathlib import Path
import re
import sys


def run(source: str) -> None:
    library = ctypes.util.find_library("icui18n")
    if not library:
        raise SystemExit("Host ICU is required for this explicit portability check")
    suffix = library.rsplit(".", 1)[-1]
    engine = ctypes.CDLL(library)
    compile_pattern = getattr(engine, "uregex_open_" + suffix)
    compile_pattern.restype = ctypes.c_void_p
    compile_pattern.argtypes = [ctypes.POINTER(ctypes.c_uint16), ctypes.c_int32,
                               ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32)]
    close = getattr(engine, "uregex_close_" + suffix)
    close.argtypes = [ctypes.c_void_p]

    def compiled(pattern: str) -> bool:
        raw = pattern.encode("utf-16-le")
        characters = (ctypes.c_uint16 * (len(raw) // 2)).from_buffer_copy(raw)
        status = ctypes.c_int32(0)
        handle = compile_pattern(characters, len(characters), 0, None, ctypes.byref(status))
        if handle:
            close(handle)
        return bool(handle) and status.value <= 0

    # A desktop Java Pattern test accepts this exact R19 expression. ICU rejects
    # it before processing any actual message, even a simple ASCII sender name.
    assert not compiled(r"(?U)\s+"), "The historical counterexample changed on this ICU"
    assert compiled(r"\s+"), "ICU control expression did not compile"
    literals = re.findall(r'\.replaceAll\(("(?:[^"\\]|\\.)*")', source)
    patterns = [json.loads(literal) for literal in literals]
    for pattern in patterns:
        assert compiled(pattern), "Production preview contains an Android-incompatible regex"
    assert "replaceAll" not in source or patterns, "A dynamic preview regex needs an explicit ICU test"
    print(json.dumps({"scope": "Host ICU portability; not physical Android delivery",
                      "engine": library, "legacyFlagRejected": True,
                      "productionRegexLiteralsChecked": len(patterns), "ok": True}))


if __name__ == "__main__":
    source_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / (
        "app/src/main/java/com/smarthandicrafts/operatorhub/MessageNotificationData.java")
    run(source_file.read_text())
