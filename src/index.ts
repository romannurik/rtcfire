/*
 * Copyright 2021 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Google STUN servers
const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
};

// Default media constraints
const DEFAULT_MEDIA_CONSTRAINTS = {
  audio: true,
  video: true,
};

const NegotiationState = {
  // offerers only
  OffererNotStarted: 'offerer:not-started',
  OffererWaitingForAnswer: 'offerer:waiting-for-answer',

  // answerers only
  AnswererWaitingForOffer: 'answerer:waiting-for-offer',

  // both
  WaitingToFinishIceCandidates: 'waiting-to-finish-ice-candidate',
  Cleanup: 'cleanup', // locally
  Complete: 'complete', // complete
};

/**
 * A Firebase Realtime Database ref per
 * {@link https://firebase.google.com/docs/reference/js/firebase.database.Reference}
 */
type FirebaseDatabaseRef = any;

/**
 * Options object to initialize an RTCFireSession.
 */
export interface RTCFireSessionOptions {
  /**
   * An ID representing the current user. Could come from Firebase Auth or elsewhere.
   */
  myId: string;

  /**
   * The root RTDB reference where WebRTC negotiations between peers should be read from/written to.
   * After negotiation, this ref shouldn't contain any data.
   */
  negotiationRef: FirebaseDatabaseRef;

  /**
   * Callback triggered when the user's local stream is available. Triggered with `null` when the
   * local stream is closed.
   */
  onMyStream: (localStream: MediaStream | null) => void;

  /**
   * Callback triggered when the given peer's media stream is available. Triggered with `null` when
   * the stream is close/no longer available.
   */
  onParticipantStream: (peerId: string, stream: MediaStream | null) => void;

  /**
   * Should the current user's local audio stream start muted? Can be changed later using
   * {@link RTCFireSession#muted}.
   */
  muted?: boolean;

  /**
   * List of initial set of peer IDs for this session. Can be changed later using
   * {@link RTCFireSession#participants}.
   */
  participants?: string[];

  /**
   * A function that returns true if the current user should be the offerer for a connection with
   * the given peer, and false if the peer should be the offerer. This should be symmetrical for
   * both sides of the connection. Defaults to whichever ID (myId or peerId) sorts first
   * alphabetically.
   */
  isOfferer?: (peerId: string) => boolean;

  /**
   * Optional media stream constraints to pass to `navigator.mediaDevices.getUserMedia`. The default
   * constraints require audio and video.
   */
  mediaConstraints?: MediaStreamConstraints;

  /**
   * A custom RTC configuration to use. The default
   * uses Google's public STUN servers.
   */
  rtcConfig?: RTCConfiguration;
}

/**
 * Class to manage an RTC session with multiple participants
 * using Firebase RTDB
 */
class RTCFireSession {
  private options: RTCFireSessionOptions;
  private participantInfo = {};
  private localStream: MediaStream = null;
  private hasLocalStreams = false;
  private _muted = false;
  private _participants: string[] = [];

  constructor(options: RTCFireSessionOptions) {
    this.options = options;
    this.options.isOfferer = this.options.isOfferer
      || (pid => this.options.myId.localeCompare(pid) < 0);
    this.participants = this.options.participants || [];

    (async () => {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(
          options.mediaConstraints || DEFAULT_MEDIA_CONSTRAINTS);
        this.hasLocalStreams = true;
        this.maybeProcessParticipantChanges();

        this.muted = !!this.options.muted;
      } catch (error) {
        console.error('Error getting local video stream', error);
      }

      this.options.onMyStream(this.localStream);
    })();
  }

  /**
   * Shuts down the entire session
   */
  close() {
    for (let pid in this.participantInfo) {
      this.onRemoveParticipant(pid);
    }

    if (this.localStream) {
      // send null stream to mitigate mobile freezing issues
      // https://github.com/twilio/twilio-video-app-react/issues/355
      this.options.onMyStream(null);
      for (let track of this.localStream.getTracks()) {
        track.stop();
      }
    }
  }

  /**
   * The list of peer IDs for this session.
   */
  get participants() {
    // TODO: cache?
    return this._participants;
  }

  /**
   * Update the list of peer IDs for this session.
   */
  set participants(participants) {
    this._participants = [...participants];
    this.maybeProcessParticipantChanges();
  }

  /**
   * Sets up connections for new participants, and
   * tears down connections for removed ones.
   */
  private maybeProcessParticipantChanges() {
    if (!this.hasLocalStreams) {
      return;
    }

    let set = new Set(this._participants);
    for (let pid of set) {
      if (!(pid in this.participantInfo) && pid !== this.options.myId) {
        this.onAddParticipant(pid);
      }
    }

    for (let existingId in this.participantInfo) {
      if (!set.has(existingId)) {
        this.onRemoveParticipant(existingId);
      }
    }
  }

  /**
   * Get the current user's audio stream muted state.
   */
  get muted() {
    return !!this._muted;
  }

  /**
   * Set the current user's audio stream muted state.
   */
  set muted(muted) {
    this._muted = muted;
    if (this.localStream) {
      for (let t of this.localStream.getTracks().filter(t => t.kind === 'audio')) {
        t.enabled = !muted;
      }
    }
  }

  /**
   * Handle a participant being added
   */
  private onAddParticipant(pid) {
    if (pid in this.participantInfo) {
      // already added
      return;
    }

    let offerer = !!this.options.isOfferer(pid);

    let readRef, writeRef;
    if (typeof this.options.negotiationRef === 'function') {
      // function signature: pid => ({ read, write });
      ({ read: readRef, write: writeRef } = this.options.negotiationRef(pid));
    } else {
      // assume it's a root ref
      writeRef = this.options.negotiationRef.child(`${this.options.myId}/${pid}`);
      readRef = this.options.negotiationRef.child(`${pid}/${this.options.myId}`);
    }

    let info = {
      readRef,
      writeRef,
      offerer,
      readVal: null,
      onReadValueChange: null,
      writeRefOnDisconnect: null,
    };

    this.participantInfo[pid] = info;
    this.initConnectionForParticipant(pid);

    info.onReadValueChange = snap => {
      info.readVal = snap.val() || {};
      this.maybeContinueNegotiation(pid);
    };
    readRef.on('value', info.onReadValueChange);
    info.writeRefOnDisconnect = writeRef.onDisconnect();
    info.writeRefOnDisconnect.set(null);
  }

  /**
   * Handles a participant being removed
   */
  private onRemoveParticipant(pid) {
    if (!(pid in this.participantInfo)) {
      return;
    }

    this.options.onParticipantStream(pid, null);
    this.teardownConnectionForParticipant(pid);
    let { onReadValueChange, readRef, writeRef, writeRefOnDisconnect } = this.participantInfo[pid];
    readRef.off('value', onReadValueChange);
    writeRef.set(null);
    writeRefOnDisconnect.cancel();
    delete this.participantInfo[pid];
  }

  /**
   * Creates a new RTC connection for the participant,
   * tearing down the existing one if it exists
   */
  private initConnectionForParticipant(pid) {
    this.teardownConnectionForParticipant(pid);

    let info = this.participantInfo[pid];
    let { offerer, writeRef } = info;

    info.negotiationState = offerer
      ? NegotiationState.OffererNotStarted
      : NegotiationState.AnswererWaitingForOffer;
    info.processedIceCandidates = new Set();

    info.conn = new RTCPeerConnection(this.options.rtcConfig || DEFAULT_RTC_CONFIG);

    info.conn.onicecandidate = ev => {
      let c = ev.candidate;
      if (!c) {
        // done
        writeRef.update({ iceDone: true });
        return;
      }
      let cKey = hashString(`${c.candidate}|${c.sdpMLineIndex}`);
      writeRef.child(`iceCandidates/${cKey}`).set({
        sdpMLineIndex: c.sdpMLineIndex,
        candidate: c.candidate,
      });
    };

    info.conn.ontrack = ev => {
      info.stream = ev.streams[0];
      this.options.onParticipantStream(pid, info.stream);
    };

    info.conn.onconnectionstatechange = () => {
      switch (info.conn.connectionState) {
        case 'connected':
          // Fully connected
          break;

        case 'disconnected':
        case 'failed':
        case 'closed':
          // Tear down and reinit connection
          this.options.onParticipantStream(pid, null);
          this.teardownConnectionForParticipant(pid);
          this.initConnectionForParticipant(pid);
          this.maybeContinueNegotiation(pid);
          break;
      }
    }

    if (offerer) {
      this.addLocalStreamToConnection(info.conn); // triggers negotiation
      info.conn.onnegotiationneeded = () => this.beginNegotiation(pid);
    }
  }

  /**
   * Tears down the RTC connection for a participant
   */
  private teardownConnectionForParticipant(pid) {
    let info = this.participantInfo[pid];
    if (!info.conn) {
      return;
    }

    info.conn.onicecandidate = null;
    info.conn.ontrack = null;
    info.conn.onconnectionstatechange = null;
    info.conn.onnegotiationneeded = null;
    info.conn.close();
    info.conn = null;
  }

  private processNewIceCandidates(pid) {
    let info = this.participantInfo[pid];
    let { conn, readVal, processedIceCandidates } = info;
    let { iceCandidates }: { iceCandidates: { [key: string]: RTCIceCandidateInit } } = readVal;
    if (!conn?.remoteDescription?.type || !iceCandidates) {
      return;
    }

    for (let { sdpMLineIndex, candidate } of Object.values(iceCandidates)) {
      let cKey = `${sdpMLineIndex}|${candidate}`;
      if (processedIceCandidates.has(cKey)) {
        continue;
      }

      conn.addIceCandidate(new RTCIceCandidate({ sdpMLineIndex, candidate, }));
      processedIceCandidates.add(cKey);
    }
  }

  /**
   * Begins WebRTC negotiation. Should only be done if we're the offerer.
   */
  private async beginNegotiation(pid) {
    let info = this.participantInfo[pid];
    if (!info) {
      return;
    }

    let { offerer, writeRef } = info;
    if (!offerer) {
      return;
    }

    info.negotiationState = NegotiationState.OffererWaitingForAnswer;
    let sessionDescription = await info.conn.createOffer();
    info.conn.setLocalDescription(sessionDescription);
    await writeRef.update({ offer: sessionDescription });
  }

  /**
   * Makes progress on negotiating the RTC connection
   * if the state requires it
   */
  private async maybeContinueNegotiation(pid) {
    let info = this.participantInfo[pid];
    let { conn, negotiationState, writeRef, readVal } = info;

    switch (negotiationState) {
      case NegotiationState.OffererNotStarted: {
        // do nothing here, as we're waiting for 'negotiationneeded'
        break;
      }

      case NegotiationState.AnswererWaitingForOffer: {
        let { offer } = readVal;
        if (offer) {
          info.negotiationState = NegotiationState.WaitingToFinishIceCandidates;
          conn.setRemoteDescription(new RTCSessionDescription(offer));
          this.addLocalStreamToConnection(info.conn);
          let sessionDescription = await conn.createAnswer();
          conn.setLocalDescription(sessionDescription);
          await writeRef.update({ answer: sessionDescription });
        }
        break;
      }

      case NegotiationState.OffererWaitingForAnswer: {
        let { answer } = readVal;
        if (answer) {
          info.negotiationState = NegotiationState.WaitingToFinishIceCandidates;
          await conn.setRemoteDescription(new RTCSessionDescription(answer));
        }
        break;
      }

      case NegotiationState.WaitingToFinishIceCandidates: {
        let { iceDone } = readVal;
        if (iceDone) {
          info.negotiationState = NegotiationState.Cleanup;
        }
        break;
      }

      case NegotiationState.Cleanup: {
        let { cleanup } = readVal;
        // we're ready for cleanup on our end, indicate as such
        writeRef.update({ cleanup: true });
        if (cleanup || Object.keys(readVal).length === 0) {
          // once remote is also ready for cleanup, move to complete state
          info.negotiationState = NegotiationState.Complete;
        }
        break;
      }

      case NegotiationState.Complete: {
        writeRef.set(null);
        break;
      }
    }

    this.processNewIceCandidates(pid);

    if (info.negotiationState !== negotiationState) {
      // progress was made, run again
      this.maybeContinueNegotiation(pid);
    }
  }

  /**
   * Attaches the local media stream to a given RTCPeerConnection,
   * if the stream exists already.
   */
  private addLocalStreamToConnection(conn) {
    if (!this.localStream) {
      return;
    }

    for (let track of this.localStream.getTracks()) {
      conn.addTrack(track, this.localStream);
    }
  }
}

/**
 * Simple function that hashes a string to another string
 */
function hashString(s) {
  let hash = 0;

  if (s.length === 0) {
    return '0';
  }

  for (let i = 0; i < s.length; i++) {
    let chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }

  return (hash & 0xfffffff).toString(36);
}

/**
 * Creates a new RTCFireSession with the given options.
 */
export function rtcFireSession(options: RTCFireSessionOptions) {
  return new RTCFireSession(options);
}