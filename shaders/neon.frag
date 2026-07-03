/* Neon Filter */
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;

varying vec2 vUv;

void main() {
    vec2 uv = vUv;
    vec4 color = texture2D(u_texture, uv);
    
    // Boost saturation
    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(color.rgb, vec3(gray), 0.3);
    color.rgb = mix(color.rgb, color.rgb * 1.5, 0.4);
    
    // Add color pulses
    float pulse = sin(u_time * 2.0) * 0.5 + 0.5;
    color.rgb *= mix(vec3(1.0), vec3(0.7, 0.1, 0.8), pulse);
    
    // Add radial glow
    vec2 center = vec2(0.5, 0.5);
    float dist = length(uv - center);
    float glow = smoothstep(0.6, 0.3, dist);
    color.rgb += vec3(0.9, 0.1, 0.8) * glow * 0.5;
    
    // Add motion trails
    float trail = sin(uv.x * 10.0 + u_time * 3.0) * 0.1;
    color.rgb += vec3(0.8, 0.9, 0.1) * trail;
    
    gl_FragColor = color;
}
