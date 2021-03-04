# rtcfire (WIP)

A simple WebRTC + Firebase Realtime Database JS library for multi-user video chat.

**WARNING: This library is experimental, and not battle-tested. Bug reports and PRs welcome.**

# Usage

```js
import { rtcFireSession } from 'rtcfire';

let session = rtcFireSession({
  // list of user IDs, including your own!
  participants: [user.uid, 'uid1', 'uid2', ...],
  // the current user's uid, probably from Firebase Auth
  myId: user.uid,
  // root path for WebRTC negotiation
  // (don't forget to protect these behind security rules!)
  // (call firebase.initializeApp(config) before calling this)
  negotiationRef: firebase.database().ref('rtcnegotiations'),
  // Set the local <video> stream
  onMyStream: stream => myVideo.srcObject = stream,
  // Set the <video> stream for the given participant
  onParticipantStream: (pid, stream) => videos[pid].srcObject = stream,
});
```

# License

Apache 2.0 (see [LICENSE](LICENSE)
