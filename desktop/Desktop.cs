using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("AION 2 Character Folio")]
[assembly: AssemblyProduct("AION 2 Character Folio")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program {
    internal static readonly Assembly Package = Assembly.GetExecutingAssembly();
    internal static string Home { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Aion2CharacterFolio"); } }
    internal static byte[] Bytes(string resource) {
        using (Stream source = Package.GetManifestResourceStream(resource))
        using (MemoryStream bytes = new MemoryStream()) { source.CopyTo(bytes); return bytes.ToArray(); }
    }
    private static string Hash(byte[] bytes) {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","");
    }
    internal static void PrepareLoader(string home) {
        byte[] bytes = Bytes("sdk.WebView2Loader.dll");
        string hash = Hash(bytes), dir = Path.Combine(home,"Runtime",hash), dll = Path.Combine(dir,"WebView2Loader.dll");
        Directory.CreateDirectory(dir);
        if (!File.Exists(dll)) {
            string temp = Path.Combine(dir,Guid.NewGuid().ToString("N")+".tmp");
            try { File.WriteAllBytes(temp,bytes); File.Move(temp,dll); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        if (Hash(File.ReadAllBytes(dll)) != hash) throw new IOException("The local runtime loader failed verification.");
        CoreWebView2Environment.LoaderDllFolderPath=dir;
    }
    [STAThread]
    private static void Main() {
        RegisterSdk();
        bool first;
        using (var mutex = new Mutex(true,@"Local\Aion2CharacterFolio.Public.v1",out first)) {
            if (!first) {
                try { using (var signal=EventWaitHandle.OpenExisting(@"Local\Aion2CharacterFolio.Show.v1")) signal.Set(); }
                catch (WaitHandleCannotBeOpenedException) { }
                return;
            }
            Application.EnableVisualStyles();
            try { RunDesktop(); }
            catch { MessageBox.Show("The planner could not start. Check that Microsoft Edge WebView2 Runtime is installed and your local app-data folder is writable.","AION 2 Character Folio"); }
        }
    }
    internal static void RegisterSdk() {
        var known = new Dictionary<string,Lazy<Assembly>>();
        foreach (string library in new[]{"Microsoft.Web.WebView2.Core","Microsoft.Web.WebView2.WinForms"}) {
            string resource="sdk."+library+".dll";
            known.Add(library,new Lazy<Assembly>(()=>Assembly.Load(Bytes(resource))));
        }
        AppDomain.CurrentDomain.AssemblyResolve += (sender,e) => {
            string name = new AssemblyName(e.Name).Name;
            Lazy<Assembly> sdk;
            return known.TryGetValue(name,out sdk)?sdk.Value:null;
        };
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunDesktop() {
        PrepareLoader(Home);
        using (var form=new Desktop(Home)) Application.Run(form);
    }
}

internal sealed class Desktop : Form {
    const string Origin="https://folio.invalid/";
    const string Csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https://assets.playnccdn.com https://profileimg.plaync.com https://profileimg.plaync.co.kr; connect-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
    readonly WebView2 view = new WebView2();
    readonly CancellationTokenSource closing = new CancellationTokenSource();
    readonly EventWaitHandle activate = new EventWaitHandle(false,EventResetMode.AutoReset,@"Local\Aion2CharacterFolio.Show.v1");
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer {Interval=300};
    readonly HttpClient http = new HttpClient(new HttpClientHandler {AllowAutoRedirect=false,UseCookies=false,UseDefaultCredentials=false}) {
        Timeout=TimeSpan.FromSeconds(18),MaxResponseContentBufferSize=4*1024*1024
    };
    internal Desktop(string home) {
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        Text="AION 2 Character Folio"; Size=new Size(1320,900); MinimumSize=new Size(360,480);
        StartPosition=FormStartPosition.CenterScreen; view.Dock=DockStyle.Fill; Controls.Add(view);
        timer.Tick+=(s,e)=>{if(activate.WaitOne(0)) {if(WindowState==FormWindowState.Minimized) WindowState=FormWindowState.Normal; Activate();}};
        Shown+=async (s,e)=>{
            try {
                var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(home,"Profile"));
                await view.EnsureCoreWebView2Async(env);
                var core=view.CoreWebView2;
                core.Settings.AreHostObjectsAllowed=false; core.Settings.IsWebMessageEnabled=false;
                core.Settings.IsPasswordAutosaveEnabled=false; core.Settings.IsGeneralAutofillEnabled=false;
                core.Settings.AreDefaultContextMenusEnabled=false; core.Settings.AreDevToolsEnabled=false;
                core.PermissionRequested+=(v,p)=>p.State=CoreWebView2PermissionState.Deny;
                core.DownloadStarting+=(v,p)=>p.Cancel=true;
                core.NavigationStarting+=(v,p)=>{Uri url; p.Cancel=!Uri.TryCreate(p.Uri,UriKind.Absolute,out url) || url.GetLeftPart(UriPartial.Path)!=Origin;};
                core.NewWindowRequested+=(v,p)=>{
                    p.Handled=true; Uri url;
                    if (p.IsUserInitiated && Uri.TryCreate(p.Uri,UriKind.Absolute,out url) && SafeHttps(url) &&
                        new[]{"notmeter.com","kisk.app","questlog.gg","aion2.gg","aion2data.com","aion2.plaync.com"}.Contains(url.Host))
                        try {Process.Start(new ProcessStartInfo(url.AbsoluteUri){UseShellExecute=true});} catch { }
                };
                core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
                core.WebResourceRequested+=Resource;
                timer.Start(); core.Navigate(Origin);
            } catch (Exception error) {
                if (!closing.IsCancellationRequested) {
                    view.Visible=false;
                    Controls.Add(new Label {Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,
                        Text="The planner window could not start. Check Microsoft Edge WebView2 Runtime and reopen the app.\nWindows error "+error.HResult.ToString("X8")});
                }
            }
        };
        FormClosing+=(s,e)=>{timer.Stop();closing.Cancel();};
        FormClosed+=(s,e)=>{http.Dispose();activate.Dispose();timer.Dispose();};
    }
    static bool SafeHttps(Uri url) {return url.Scheme=="https" && url.IsDefaultPort && url.UserInfo.Length==0;}
    internal static Uri Upstream(Uri url) {
        var q=HttpUtility.ParseQueryString(url.Query);
        string route=url.AbsolutePath;
        string fields, target;
        if (route=="/nc/search") {
            fields="keyword region localeInfo size page"; target="https://api-search.plaync.com/aion2global/search/v2/character";
            int page;
            if (String.IsNullOrWhiteSpace(q["keyword"]) || q["keyword"].Length>64 || q["localeInfo"]!="en-US" ||
                q["size"]!="20" || !int.TryParse(q["page"],out page) || page<1 || page>99999) return null;
        } else {
            if (route!="/nc/info" && route!="/nc/equipment" && route!="/nc/item") return null;
            fields="region serverId characterId lang";
            if(q["lang"]!="en-US" || String.IsNullOrEmpty(q["characterId"]) || q["characterId"].Length>256) return null;
            if(route=="/nc/item") fields+=" id slotPos enchantLevel exceedLevel";
            foreach(var name in fields.Split(' ').Where(k=>new[]{"serverId","id","slotPos","enchantLevel","exceedLevel"}.Contains(k))) {
                uint n; if(!UInt32.TryParse(q[name],out n)) return null;
            }
            target="https://aion2.plaync.com/api/character/"+(route=="/nc/item"?"equipment/item":route.Substring(4));
        }
        if (!new[]{"nae","naw","eu","la","as"}.Contains(q["region"])) return null;
        var keys=fields.Split(' ');
        if(q.Count!=keys.Length || keys.Any(k=>q.GetValues(k)==null || q.GetValues(k).Length!=1)) return null;
        return new Uri(target+"?"+String.Join("&",keys.Select(k=>k+"="+Uri.EscapeDataString(q[k]))));
    }
    void Reply(CoreWebView2WebResourceRequestedEventArgs e,int status,string type,Stream bytes) {
        string headers="Content-Type: "+type+"\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nContent-Security-Policy: "+Csp;
        e.Response=view.CoreWebView2.Environment.CreateWebResourceResponse(bytes,status,status==200?"OK":"Unavailable",headers);
    }
    async void Resource(object sender,CoreWebView2WebResourceRequestedEventArgs e) {
        var uri=new Uri(e.Request.Uri);
        if (SafeHttps(uri) && new[]{"assets.playnccdn.com","profileimg.plaync.com","profileimg.plaync.co.kr"}.Contains(uri.Host) &&
            e.ResourceContext==CoreWebView2WebResourceContext.Image && e.Request.Method=="GET") return;
        if (!SafeHttps(uri) || uri.Host!="folio.invalid" || e.Request.Method!="GET") {Reply(e,403,"text/plain",null);return;}
        if (!uri.AbsolutePath.StartsWith("/nc/",StringComparison.Ordinal)) {
            string key=uri.AbsolutePath=="/"?"index.html":uri.AbsolutePath.Substring(1);
            Stream asset=Program.Package.GetManifestResourceStream("web."+key);
            if(asset==null) {Reply(e,404,"text/plain",null);return;}
            string type=key.EndsWith(".html")?"text/html; charset=utf-8":key.EndsWith(".js")?"text/javascript; charset=utf-8":
                key.EndsWith(".css")?"text/css; charset=utf-8":key.EndsWith(".ttf")?"font/ttf":"text/plain; charset=utf-8";
            Reply(e,200,type,asset);return;
        }
        var upstream=Upstream(uri);
        if(upstream==null){Reply(e,400,"text/plain",null);return;}
        var deferral=e.GetDeferral();
        try {
            using (var response=await http.GetAsync(upstream,closing.Token)) {
                if (!closing.IsCancellationRequested) {
                    var body=response.IsSuccessStatusCode?new MemoryStream(await response.Content.ReadAsByteArrayAsync()):null;
                    Reply(e,response.IsSuccessStatusCode?200:((int)response.StatusCode==429?429:502),"application/json",body);
                }
            }
        } catch {if(!closing.IsCancellationRequested) Reply(e,502,"text/plain",null);}
        finally {try{deferral.Complete();}catch(ObjectDisposedException){}catch(System.Runtime.InteropServices.COMException){}}
    }
}
