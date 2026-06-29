// Generate the Tsugi agent gRPC client from the shared contract. Client-only —
// Yagura is the read plane that dials Tsugi (the write plane serves it).
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(&["proto/tsugi_agent.proto"], &["proto"])?;
    Ok(())
}
