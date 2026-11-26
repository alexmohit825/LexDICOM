import struct
import subprocess
import os

sizes = [256, 128, 64, 48, 32, 16]
png_files = []

for s in sizes:
    png_path = f"C:/Users/mohal/Documents/antigravity/LexDICOM/public/icons/icon_{s}.png"
    ps_cmd = f'Add-Type -AssemblyName System.Drawing; $src = [System.Drawing.Image]::FromFile("C:/Users/mohal/Documents/antigravity/LexDICOM/public/icons/icon-512.png"); $b = New-Object System.Drawing.Bitmap {s}, {s}; $g = [System.Drawing.Graphics]::FromImage($b); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($src, 0, 0, {s}, {s}); $b.Save("{png_path}", [System.Drawing.Imaging.ImageFormat]::Png); $src.Dispose(); $b.Dispose()'
    subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], check=True)
    with open(png_path, "rb") as f:
        png_files.append((s, f.read()))
    os.remove(png_path)

num_images = len(png_files)
ico_header = struct.pack("<HHH", 0, 1, num_images)
offset = 6 + 16 * num_images
entries = bytearray()
data_blobs = bytearray()

for s, data in png_files:
    w = 0 if s == 256 else s
    h = 0 if s == 256 else s
    size = len(data)
    entry = struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, offset)
    entries.extend(entry)
    data_blobs.extend(data)
    offset += size

ico_path = "C:/Users/mohal/Documents/antigravity/LexDICOM/public/icons/LexDICOM.ico"
with open(ico_path, "wb") as f:
    f.write(ico_header + entries + data_blobs)

print("Proper multi-res ICO created at:", ico_path, "size:", os.path.getsize(ico_path))
