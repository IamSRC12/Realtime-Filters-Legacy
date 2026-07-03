/* Cyberpunk Filter */
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;

varying vec2 vUv;

void main() {
    vec2 uv = vUv;
    vec4 color = texture2D(u_texture, uv);
    
    // Desaturate slightly
    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(color.rgb, vec3(gray), 0.1);
    
    // Add neon pink/cyan glow
    vec3 neon = vec3(0.9, 0.0, 0.9);
    vec3 glow = vec3(0.0, 0.9, 0.9);
    
    // Detect bright areas
    float bright = max(color.r, max(color.g, color.b));
    bright = smoothstep(0.8, 1.0, bright);
    
    // Add glow
    color.rgb += neon * bright * 0.8;
    color.rgb += glow * bright * 0.6;
    
    // Add scanlines
    float scan = sin(uv.y * u_resolution.y * 2.0) * 0.1;
    color.rgb *= 0.9 + scan;
    
    // Add CRT distortion
    float distortion = sin(uv.y * 10.0 + u_time * 0.5) * 0.02;
    uv.x += distortion;
    
    gl_FragColor = color;
}
