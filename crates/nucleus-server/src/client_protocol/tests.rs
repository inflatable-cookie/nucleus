use super::*;

#[test]
fn first_client_protocol_profile_names_control_and_event_envelopes() {
    let profile = ClientProtocolProfile::v1_control_and_events();

    assert_eq!(profile.family, CLIENT_PROTOCOL_FAMILY);
    assert_eq!(profile.version, CLIENT_PROTOCOL_VERSION_V1);
    assert_eq!(
        profile.compatibility,
        ClientProtocolCompatibility::ExactVersionOnly
    );
    assert!(profile.supports_message(ClientProtocolMessageKind::ControlRequest));
    assert!(profile.supports_message(ClientProtocolMessageKind::ControlResponse));
    assert!(profile.supports_message(ClientProtocolMessageKind::ServerEvent));
}

#[test]
fn protocol_profile_keeps_boundary_authority_out_of_durable_state() {
    let profile = ClientProtocolProfile::v1_control_and_events();

    assert_eq!(
        profile.authority,
        ClientProtocolAuthority::ProtocolBoundaryOnly
    );

    let readiness = profile.assess_readiness(true, true, true, true);

    assert_eq!(readiness.status, ClientProtocolReadinessStatus::Ready);
    assert!(readiness.blockers.is_empty());
}

#[test]
fn protocol_profile_blocks_transport_work_until_event_shape_is_defined() {
    let profile = ClientProtocolProfile::v1_control_and_events();

    let readiness = profile.assess_readiness(true, false, true, true);

    assert_eq!(readiness.status, ClientProtocolReadinessStatus::Deferred);
    assert!(readiness
        .blockers
        .contains(&ClientProtocolReadinessBlocker::EventEnvelopeShapeDeferred));
}

#[test]
fn event_envelope_shape_names_replay_without_implementing_subscription() {
    let event_shape = ClientProtocolMessageShape::server_event();

    assert_eq!(event_shape.kind, ClientProtocolMessageKind::ServerEvent);
    assert!(event_shape
        .fields
        .contains(&ClientProtocolEnvelopeField::EventId));
    assert!(event_shape
        .fields
        .contains(&ClientProtocolEnvelopeField::ReplayToken));
    assert!(event_shape
        .fields
        .contains(&ClientProtocolEnvelopeField::Payload));
}
