$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = 5173
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
[Console]::Out.WriteLine("Serving $root at $prefix")

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
  '.map'  = 'application/json; charset=utf-8'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = [uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/' -or [string]::IsNullOrEmpty($path)) { $path = '/index.html' }
    $localPath = Join-Path $root ($path.TrimStart('/'))
    if ((Test-Path $localPath -PathType Container)) { $localPath = Join-Path $localPath 'index.html' }
    try {
      if (Test-Path $localPath -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($localPath)
        $ext = [System.IO.Path]::GetExtension($localPath).ToLowerInvariant()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.StatusCode = 200
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
    } catch {
      $res.StatusCode = 500
      $msg = [Text.Encoding]::UTF8.GetBytes("500 Error: $($_.Exception.Message)")
      $res.OutputStream.Write($msg, 0, $msg.Length)
    } finally {
      $res.OutputStream.Close()
    }
    [Console]::Out.WriteLine("$($req.HttpMethod) $($req.Url.AbsolutePath) -> $($res.StatusCode)")
  }
} finally {
  $listener.Stop()
}
