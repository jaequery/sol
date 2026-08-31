//! A dependency-free HTTP/1.1 stub, so the result download's real request/response path
//! is exercised in tests without reaching the internet. (Everything else the wrapper
//! does goes through the CLI, which the tests stub as an executable instead.)

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener};

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn bytes(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "video/mp4".into())],
            body,
        }
    }
}

pub struct MockServer {
    pub addr: SocketAddr,
}

impl MockServer {
    /// Serve `handler` until the process ends, handing it each request's index in order.
    pub fn start<F>(handler: F) -> Self
    where
        F: Fn(usize) -> Response + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");

        std::thread::spawn(move || {
            let mut count = 0usize;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                if !read_request(&mut stream) {
                    continue;
                }
                let response = handler(count);
                count += 1;
                write_response(&mut stream, response);
            }
        });

        Self { addr }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

/// Read one request off the socket, returning whether a whole one arrived.
fn read_request(stream: &mut std::net::TcpStream) -> bool {
    let Ok(clone) = stream.try_clone() else {
        return false;
    };
    let mut reader = BufReader::new(clone);

    let mut start = String::new();
    if reader.read_line(&mut start).is_err() || start.trim().is_empty() {
        return false;
    }

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }

    if content_length > 0 {
        let mut body = vec![0u8; content_length];
        if reader.read_exact(&mut body).is_err() {
            return false;
        }
    }
    true
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
