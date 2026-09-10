//! Native live relay: a y-websocket compatible server inside the app, so hosting a session
//! needs nothing but Dabir. Rooms are in memory for the life of the session; the paper's
//! truth stays in the host's Git checkout. `relay/server.mjs` is the same protocol for a
//! standalone server.

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Path as AxPath, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, RwLock};
use yrs::sync::Awareness;
use yrs::Doc;
use yrs_axum::{
    broadcast::BroadcastGroup,
    ws::{AxumSink, AxumStream},
    AwarenessRef,
};

type Rooms = Arc<RwLock<HashMap<String, Arc<BroadcastGroup>>>>;

static SHUTDOWN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);
static PORT: Mutex<Option<u16>> = Mutex::new(None);

pub fn running_port() -> Option<u16> {
    *PORT.lock().unwrap()
}

async fn room(rooms: &Rooms, name: &str) -> Arc<BroadcastGroup> {
    if let Some(r) = rooms.read().await.get(name) {
        return r.clone();
    }
    let mut w = rooms.write().await;
    if let Some(r) = w.get(name) {
        return r.clone();
    }
    let awareness: AwarenessRef = Arc::new(RwLock::new(Awareness::new(Doc::new())));
    let group = Arc::new(BroadcastGroup::new(awareness, 64).await);
    w.insert(name.to_string(), group.clone());
    group
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    AxPath(name): AxPath<String>,
    State(rooms): State<Rooms>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| peer(socket, rooms, name))
}

async fn peer(socket: WebSocket, rooms: Rooms, name: String) {
    let group = room(&rooms, &name).await;
    let (sink, stream) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(AxumSink::from(sink)));
    let stream = AxumStream::from(stream);
    let sub = group.subscribe(sink, stream);
    let _ = sub.completed().await;
}

/// Start listening on all interfaces. Returns once the socket is bound.
pub fn start(port: u16) -> Result<(), String> {
    if running_port() == Some(port) {
        return Ok(());
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        rt.block_on(async move {
            let rooms: Rooms = Arc::new(RwLock::new(HashMap::new()));
            let app = Router::new()
                .route("/{room}", get(ws_handler))
                .with_state(rooms);
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("Could not listen on port {}: {}", port, e)));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await;
        });
    });
    ready_rx
        .recv()
        .map_err(|_| "Relay thread died before binding".to_string())??;
    *SHUTDOWN.lock().unwrap() = Some(stop_tx);
    *PORT.lock().unwrap() = Some(port);
    Ok(())
}

pub fn stop() -> bool {
    *PORT.lock().unwrap() = None;
    match SHUTDOWN.lock().unwrap().take() {
        Some(tx) => {
            let _ = tx.send(());
            true
        }
        None => false,
    }
}
