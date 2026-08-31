//! A dependency-free HTTP/1.1 stub, so a real request/response path is exercised in
//! tests without reaching the internet — the result download, and the credential check
//! against the Cloud API.
//!
//! Every request is recorded, which is what lets a test assert the exact path and the
//! exact `Authorization` header that went out rather than only what came back.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};

pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    /// Kept as bytes so a binary upload can be asserted on exactly.
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("a JSON request body")
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn bytes(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "video/mp4".into())],
            body,
        }
    }

    pub fn with_header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub struct MockServer {
    pub addr: SocketAddr,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl MockServer {
    /// Serve `handler` until the process ends. The handler sees every request in order.
    pub fn start<F>(handler: F) -> Self
    where
        F: Fn(&Request, usize) -> Response + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen: Arc<Mutex<Vec<Request>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Some(req) = read_request(&mut stream) else {
                    continue;
                };
                let index = {
                    let mut guard = sink.lock().unwrap();
                    guard.push(req);
                    guard.len() - 1
                };
                let response = {
                    let guard = sink.lock().unwrap();
                    handler(&guard[index], index)
                };
                write_response(&mut stream, response);
            }
        });

        Self { addr, seen }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn request_count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    /// The first request that hit `path`, for asserting on one leg of a multi-step flow.
    pub fn with_first<T>(&self, path: &str, f: impl FnOnce(&Request) -> T) -> T {
        let guard = self.seen.lock().unwrap();
        let found = guard
            .iter()
            .find(|r| r.path == path)
            .unwrap_or_else(|| panic!("no request to {path}"));
        f(found)
    }

    pub fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);

    let mut start = String::new();
    reader.read_line(&mut start).ok()?;
    let mut parts = start.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let (k, v) = (k.trim().to_string(), v.trim().to_string());
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.parse().unwrap_or(0);
            }
            headers.push((k, v));
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }

    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(stream: &mut std::net::TcpStream, response: Response) {
    let mut head = format!("HTTP/1.1 {} OK\r\n", response.status);
    head.push_str(&format!("content-length: {}\r\n", response.body.len()));
    for (k, v) in &response.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("connection: close\r\n\r\n");

    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}
