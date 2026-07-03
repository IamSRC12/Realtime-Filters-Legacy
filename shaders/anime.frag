/* Anime Filter */
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;

varying vec2 vUv;

void main() {
    vec2 uv = vUv;
    vec4 color = texture2D(u_texture, uv);
    
    // Cel shading: quantize colors
    color.rgb = floor(color.rgb * 8.0) / 8.0;
    
    // Edge detection (sobel)
    float strength = 0.2;
    vec2 texelSize = 1.0 / u_resolution;
    
    float dx = texture2D(u_texture, uv + vec2(texelSize.x, 0.0)).r - texture2D(u_texture, uv - vec2(texelSize.x, 0.0)).r;
    float dy = texture2D(u_texture, uv + vec2(0.0, texelSize.y)).r - texture2D(u_texture, uv - vec2(0.0, texelSize.y)).r;
    float edge = length(vec2(dx, dy));
    
    // Apply edge outline
    color.rgb = mix(color.rgb, vec3(0.0), smoothstep(0.0, 0.1, edge) * strength);
    
    gl_FragColor = color;
}
