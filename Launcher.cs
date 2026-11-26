using System;
using System.Diagnostics;
using System.IO;

namespace LexDICOM
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            string url = "https://alexmohit825.github.io/LexDICOM/";
            string chromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
            string edgePath = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";

            ProcessStartInfo psi = new ProcessStartInfo();
            if (File.Exists(chromePath))
            {
                psi.FileName = chromePath;
                psi.Arguments = "--app=" + url;
            }
            else if (File.Exists(edgePath))
            {
                psi.FileName = edgePath;
                psi.Arguments = "--app=" + url;
            }
            else
            {
                psi.FileName = url;
                psi.UseShellExecute = true;
            }

            try
            {
                Process.Start(psi);
            }
            catch { }
        }
    }
}
