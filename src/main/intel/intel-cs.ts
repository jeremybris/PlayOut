/**
 * The C# behind intel-graphics.ts: Intel Graphics Control Library (IGCL, C:\Windows\System32\ControlLib.dll) calls
 * for the driver's Endurance Gaming setting, compiled once per worker process with Add-Type (Windows PowerShell 5.1:
 * C# 5 only). It runs in its own PowerShell worker, never in the native host.
 *
 * Struct layouts follow Intel's public header include/igcl_api.h of github.com/intel/drivers.gpu.control-library at
 * commit 52c15725b52e372ca53a9896976cf08f47a39053 ("Updated version to v306", the version of ControlLib.dll 1.3.306
 * shipped with the driver). Offsets are for 64-bit processes (MSVC default packing); the class refuses to run in a
 * 32-bit process.
 *
 *   ctl_init_args_t (36 bytes)            Size@0 Version@4 AppVersion@8 flags@12 SupportedVersion@16 ApplicationUID@20
 *   ctl_device_adapter_properties_t (320) Size@0 Version@4 pDeviceID@8 device_id_size@16 device_type@20
 *                                         supported_subfunction_flags@24 driver_version@32 pci_vendor_id@64 name@88
 *   ctl_3d_feature_caps_t (24)            Size@0 Version@4 NumSupportedFeatures@8 pFeatureDetails@16
 *   ctl_3d_feature_details_t (72)         FeatureType@0 ValueType@4 Value@8 CustomValueSize@32 pCustomValue@40
 *   ctl_3d_feature_getset_t (56)          Size@0 Version@4 FeatureType@8 ApplicationName@16 ApplicationNameLength@24
 *                                         bSet@25 ValueType@28 Value@32 CustomValueSize@40 pCustomValue@48
 *   ctl_endurance_gaming_caps_t (32)      EGControlCaps{SupportedTypes u64@0, DefaultType@8} EGModeCaps{@16, @24}
 *   ctl_endurance_gaming_t (8)            EGControl@0 EGMode@4
 *
 * Every call is global (ApplicationName null): PlayOut never writes a per-application driver value.
 * Each public method returns one JSON string, parsed by intel-graphics.ts.
 */
export const INTEL_INIT = String.raw`
if (-not ('PlayOut.Igcl' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace PlayOut {
  public static class Igcl {
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlInit(IntPtr args, out IntPtr api);
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlClose(IntPtr api);
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlEnumerateDevices(IntPtr api, ref uint count, IntPtr devices);
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlGetDeviceProperties(IntPtr dev, IntPtr props);
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlGetSupported3DCapabilities(IntPtr dev, IntPtr caps);
    [DllImport("ControlLib.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern uint ctlGetSet3DFeature(IntPtr dev, IntPtr feature);

    const int FEATURE_ENDURANCE_GAMING = 1;
    const int VALUE_TYPE_CUSTOM = 5;
    const int DETAILS = 72, GETSET = 56, PROPS = 320;

    static IntPtr Zero(int n) {
      IntPtr p = Marshal.AllocHGlobal(n);
      for (int i = 0; i < n; i++) Marshal.WriteByte(p, i, 0);
      return p;
    }

    static string Str(string s) {
      if (s == null) return "null";
      StringBuilder b = new StringBuilder("\"");
      foreach (char c in s) {
        if (c == '"' || c == '\\') b.Append('\\').Append(c);
        else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
        else b.Append(c);
      }
      return b.Append('"').ToString();
    }

    static string Fail(string stage, long code) {
      return "{\"ok\":false,\"stage\":" + Str(stage) + ",\"code\":" + code + "}";
    }

    // Reads (and with set=true, first writes) the global Endurance Gaming value. control/mode -1 keep the current one.
    static string Run(bool set, int control, int mode) {
      if (IntPtr.Size != 8) return Fail("bitness", 0);
      IntPtr api = IntPtr.Zero;
      IntPtr args = Zero(64);
      try {
        Marshal.WriteInt32(args, 0, 36);
        Marshal.WriteInt32(args, 8, (1 << 16) | 1);
        uint r;
        try {
          r = ctlInit(args, out api);
        } catch (DllNotFoundException) {
          return Fail("dll", 0);
        } catch (EntryPointNotFoundException) {
          return Fail("dll", 0);
        }
        if (r != 0) return Fail("init", r);
        return Device(api, set, control, mode);
      } finally {
        if (api != IntPtr.Zero) ctlClose(api);
        Marshal.FreeHGlobal(args);
      }
    }

    static string Device(IntPtr api, bool set, int control, int mode) {
      uint count = 0;
      uint r = ctlEnumerateDevices(api, ref count, IntPtr.Zero);
      if (r != 0) return Fail("enumerate", r);
      if (count == 0) return Fail("device", 0);
      IntPtr devs = Zero((int)count * 8);
      try {
        r = ctlEnumerateDevices(api, ref count, devs);
        if (r != 0) return Fail("enumerate", r);
        for (int d = 0; d < count; d++) {
          IntPtr dev = Marshal.ReadIntPtr(devs, d * 8);
          IntPtr props = Zero(PROPS);
          IntPtr luid = Zero(8);
          try {
            Marshal.WriteInt32(props, 0, PROPS);
            Marshal.WriteByte(props, 4, 2);
            Marshal.WriteIntPtr(props, 8, luid);
            Marshal.WriteInt32(props, 16, 8);
            if (ctlGetDeviceProperties(dev, props) != 0) continue;
            // Intel vendor id and the 3D sub-function (CTL_SUPPORTED_FUNCTIONS_FLAG_3D).
            if (Marshal.ReadInt32(props, 64) != 0x8086 || (Marshal.ReadInt32(props, 24) & 2) == 0) continue;
            string name = Marshal.PtrToStringAnsi(IntPtr.Add(props, 88));
            return "{\"ok\":true,\"device\":" + Str(name) + ",\"eg\":" + Endurance(dev, set, control, mode) + "}";
          } finally {
            Marshal.FreeHGlobal(props);
            Marshal.FreeHGlobal(luid);
          }
        }
        return Fail("device", 0);
      } finally {
        Marshal.FreeHGlobal(devs);
      }
    }

    static string Endurance(IntPtr dev, bool set, int control, int mode) {
      IntPtr caps = Zero(24);
      IntPtr det = IntPtr.Zero;
      IntPtr capsBuf = IntPtr.Zero;
      try {
        Marshal.WriteInt32(caps, 0, 24);
        uint r = ctlGetSupported3DCapabilities(dev, caps);
        if (r != 0) return "{\"listed\":false,\"capsCode\":" + r + "}";
        int n = Marshal.ReadInt32(caps, 8);
        if (n <= 0 || n > 256) return "{\"listed\":false,\"capsCode\":0}";
        det = Zero(n * DETAILS);
        Marshal.WriteIntPtr(caps, 16, det);
        r = ctlGetSupported3DCapabilities(dev, caps);
        if (r != 0) return "{\"listed\":false,\"capsCode\":" + r + "}";
        IntPtr entry = IntPtr.Zero;
        for (int i = 0; i < n; i++) {
          IntPtr e = IntPtr.Add(det, i * DETAILS);
          if (Marshal.ReadInt32(e, 0) == FEATURE_ENDURANCE_GAMING) { entry = e; break; }
        }
        if (entry == IntPtr.Zero) return "{\"listed\":false,\"capsCode\":0}";
        if (Marshal.ReadInt32(entry, 4) != VALUE_TYPE_CUSTOM || Marshal.ReadInt32(entry, 32) < 32)
          return "{\"listed\":true,\"capsCode\":0,\"layout\":false}";
        // A custom feature's caps come from a second, single-feature call with the custom buffer allocated.
        int capsSize = Marshal.ReadInt32(entry, 32);
        capsBuf = Zero(capsSize);
        Marshal.WriteIntPtr(entry, 40, capsBuf);
        IntPtr one = Zero(24);
        try {
          Marshal.WriteInt32(one, 0, 24);
          Marshal.WriteInt32(one, 8, 1);
          Marshal.WriteIntPtr(one, 16, entry);
          r = ctlGetSupported3DCapabilities(dev, one);
        } finally {
          Marshal.FreeHGlobal(one);
          Marshal.WriteIntPtr(entry, 40, IntPtr.Zero);
        }
        if (r != 0) return "{\"listed\":true,\"capsCode\":" + r + "}";
        long controlMask = Marshal.ReadInt64(capsBuf, 0);
        int controlDefault = Marshal.ReadInt32(capsBuf, 8);
        long modeMask = Marshal.ReadInt64(capsBuf, 16);
        int modeDefault = Marshal.ReadInt32(capsBuf, 24);
        string caps2 = "\"listed\":true,\"capsCode\":0,\"controlMask\":" + controlMask + ",\"controlDefault\":" + controlDefault +
          ",\"modeMask\":" + modeMask + ",\"modeDefault\":" + modeDefault;

        int curControl, curMode;
        uint g = Get(dev, out curControl, out curMode);
        if (g != 0) return "{" + caps2 + ",\"getCode\":" + g + "}";
        string setPart = "";
        if (set) {
          int newControl = control >= 0 ? control : curControl;
          int newMode = mode >= 0 ? mode : curMode;
          uint s = Put(dev, newControl, newMode);
          setPart = ",\"setCode\":" + s;
          g = Get(dev, out curControl, out curMode);
          if (g != 0) return "{" + caps2 + setPart + ",\"getCode\":" + g + "}";
        }
        return "{" + caps2 + setPart + ",\"getCode\":0,\"control\":" + curControl + ",\"mode\":" + curMode + "}";
      } finally {
        Marshal.FreeHGlobal(caps);
        if (det != IntPtr.Zero) Marshal.FreeHGlobal(det);
        if (capsBuf != IntPtr.Zero) Marshal.FreeHGlobal(capsBuf);
      }
    }

    static uint Call(IntPtr dev, bool set, IntPtr custom) {
      IntPtr gs = Zero(GETSET);
      try {
        Marshal.WriteInt32(gs, 0, GETSET);
        Marshal.WriteInt32(gs, 8, FEATURE_ENDURANCE_GAMING);
        Marshal.WriteIntPtr(gs, 16, IntPtr.Zero);
        Marshal.WriteByte(gs, 25, (byte)(set ? 1 : 0));
        Marshal.WriteInt32(gs, 28, VALUE_TYPE_CUSTOM);
        Marshal.WriteInt32(gs, 40, 8);
        Marshal.WriteIntPtr(gs, 48, custom);
        return ctlGetSet3DFeature(dev, gs);
      } finally {
        Marshal.FreeHGlobal(gs);
      }
    }

    static uint Get(IntPtr dev, out int control, out int mode) {
      IntPtr v = Zero(8);
      try {
        uint r = Call(dev, false, v);
        control = Marshal.ReadInt32(v, 0);
        mode = Marshal.ReadInt32(v, 4);
        return r;
      } finally {
        Marshal.FreeHGlobal(v);
      }
    }

    static uint Put(IntPtr dev, int control, int mode) {
      IntPtr v = Zero(8);
      try {
        Marshal.WriteInt32(v, 0, control);
        Marshal.WriteInt32(v, 4, mode);
        return Call(dev, true, v);
      } finally {
        Marshal.FreeHGlobal(v);
      }
    }

    public static string Status() {
      try { return Run(false, -1, -1); } catch (Exception e) { return "{\"ok\":false,\"stage\":\"exception\",\"code\":0,\"message\":" + Str(e.Message) + "}"; }
    }

    public static string SetEndurance(int control, int mode) {
      if (control < 0 || control > 2 || mode < -1 || mode > 2) return Fail("argument", 0);
      try { return Run(true, control, mode); } catch (Exception e) { return "{\"ok\":false,\"stage\":\"exception\",\"code\":0,\"message\":" + Str(e.Message) + "}"; }
    }
  }
}
'@
}
`
