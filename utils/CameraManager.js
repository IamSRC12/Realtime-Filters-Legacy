/**
 * CameraManager.js
 * Handles webcam access and stream management
 */
class CameraManager {
  constructor(videoElement) {
    this.video      = videoElement;
    this.stream     = null;
    this.facingMode = 'user';
  }

  async start() {
    const constraints = {
      video: {
        facingMode: this.facingMode,
        width:     { ideal: 1280 },
        height:    { ideal: 720 },
        frameRate: { ideal: 30, max: 60 }
      },
      audio: false
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await new Promise(resolve => {
      this.video.onloadedmetadata = () => { this.video.play(); resolve(); };
    });
    return true;
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  async toggleCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    this.stop();
    await this.start();
  }

  get width()  { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }
  get isReady() { return this.video.readyState === this.video.HAVE_ENOUGH_DATA; }
}
