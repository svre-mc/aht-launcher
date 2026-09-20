using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Controls only the uniquely titled disposable NSIS fixture created by its test.
class UninstallUi {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr region, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int state);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  struct Rect { public int L,T,R,B; }
  static string Text(IntPtr h) { var b=new StringBuilder(1024); GetWindowText(h,b,b.Capacity); return b.ToString(); }
  static int Main(string[] a) {
    try {
      if(a[1]=="cleanup") {
        EnumWindows((h,p)=>{if(Text(h).Contains(a[0]))PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);
        return 0;
      }
      IntPtr window=IntPtr.Zero, check=IntPtr.Zero;
      var until=DateTime.UtcNow.AddSeconds(20);
      while(DateTime.UtcNow<until && check==IntPtr.Zero) {
        EnumWindows((h,p)=>{if(IsWindowVisible(h)&&Text(h).Contains(a[0]))window=h;return true;},IntPtr.Zero);
        if(window!=IntPtr.Zero) EnumChildWindows(window,(h,p)=>{if(Text(h)=="Remove AHT modpacks and game data")check=h;return true;},IntPtr.Zero);
        if(check==IntPtr.Zero)Thread.Sleep(100);
      }
      if(check==IntPtr.Zero)throw new Exception("Uninstall options page not found");
      ShowWindow(window,9);
      Thread.Sleep(300);
      bool explanation=false;
      EnumChildWindows(window,(h,p)=>{if(Text(h).Contains("Permanently deletes")&&Text(h).Contains("saved worlds"))explanation=true;return true;},IntPtr.Zero);
      if(!explanation)throw new Exception("Data-removal explanation was not shown");
      if(a[1]=="inspect") {
        EnumChildWindows(window,(h,p)=>{Rect rr;GetWindowRect(h,out rr);Console.WriteLine("visible="+IsWindowVisible(h)+" enabled="+IsWindowEnabled(h)+" rect="+rr.L+","+rr.T+","+rr.R+","+rr.B+" text="+Text(h));return true;},IntPtr.Zero);
        return 0;
      }
      bool enabled=IsWindowEnabled(check);
      int state=SendMessage(check,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32();
      if(state!=(a[2]=="1"?1:0)||enabled!=(a[3]=="1"))throw new Exception("Unexpected default checkbox state");
      if(a.Length>4) {
        SetForegroundWindow(window);
        Thread.Sleep(200);
        RedrawWindow(window,IntPtr.Zero,IntPtr.Zero,0x185);
        Rect r; GetWindowRect(window,out r);
        using(var bmp=new Bitmap(r.R-r.L,r.B-r.T))using(var g=Graphics.FromImage(bmp)) {
          if(GetForegroundWindow()==window)g.CopyFromScreen(r.L,r.T,0,0,bmp.Size);
          else { IntPtr dc=g.GetHdc(); PrintWindow(window,dc,0);g.ReleaseHdc(dc); }
          bmp.Save(a[4],ImageFormat.Png);
        }
      }
      if(a[1]=="cancel")PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero);
      else {
        if(a[1]=="keep"||a[1]=="back")SendMessage(check,0xF1,IntPtr.Zero,IntPtr.Zero);
        SendMessage(window,0x111,new IntPtr(1),GetDlgItem(window,1));
        if(a[1]=="back") {
          Thread.Sleep(200);
          SendMessage(window,0x111,new IntPtr(3),GetDlgItem(window,3));
          Thread.Sleep(200);
          check=IntPtr.Zero;
          EnumChildWindows(window,(h,p)=>{if(Text(h)=="Remove AHT modpacks and game data")check=h;return true;},IntPtr.Zero);
          if(check==IntPtr.Zero||SendMessage(check,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32()!=0)throw new Exception("Back navigation reset the keep-data choice");
          SendMessage(window,0x111,new IntPtr(1),GetDlgItem(window,1));
          Thread.Sleep(200);
          SendMessage(window,0x111,new IntPtr(1),GetDlgItem(window,1));
        }
      }
      Console.WriteLine("PASS options: checked="+state+", enabled="+enabled+", action="+a[1]);return 0;
    }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
  }
}
