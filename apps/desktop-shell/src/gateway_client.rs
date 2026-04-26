use anyhow::{anyhow, Context, Result};
use serde::de::DeserializeOwned;
use vulture_core::RuntimeDescriptor;

/// Thin HTTP client for the local Bun gateway. Phase 2 only needs read paths
/// from the legacy sidecar; full coverage comes when sidecar is deleted in
/// Phase 3.
pub struct GatewayClient {
    base: String,
    token: String,
    client: reqwest::Client,
}

impl GatewayClient {
    pub fn from_runtime(rt: &RuntimeDescriptor) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .context("build reqwest client")?;
        Ok(Self {
            base: format!("http://127.0.0.1:{}", rt.gateway.port),
            token: rt.token.clone(),
            client,
        })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("gateway {status} on GET {url}: {body}"));
        }
        resp.json::<T>().await.context("parse gateway response")
    }
}
